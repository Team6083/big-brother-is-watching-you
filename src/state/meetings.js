import {meetingTimes,meetingEnd,recordDate,recordLink} from "../meetings.js";
export class PostgresMeetingStore {
  constructor(db){this.db=db;}
  async get(id) { return (await this.db.prepare('SELECT * FROM meetings WHERE channel_id=?').get(id)); }
  async set(id,date,time,actor,location,now=Date.now(),endTime) {
    location=location?.trim();
    if(!location || location.length>200 || /[\r\n]/.test(location))throw new Error('請填入會議地點（單行，最多 200 字）。');
    const {starts,remind}=meetingTimes(date,time,now);
    const ends=meetingEnd(date,time,endTime);
    const row=await this.db.prepare(`WITH previous AS (
      SELECT * FROM meetings WHERE channel_id=$1 FOR UPDATE
    ), saved AS (
      INSERT INTO meetings(channel_id,starts_at,remind_at,actor_id,location,ends_at,status) VALUES($1,$2,$3,$4,$5,$6,'pending')
      ON CONFLICT(channel_id) DO UPDATE SET starts_at=excluded.starts_at,remind_at=excluded.remind_at,
        actor_id=excluded.actor_id,location=excluded.location,ends_at=excluded.ends_at,
        status=CASE WHEN meetings.starts_at=excluded.starts_at AND meetings.status!='cancelled' THEN meetings.status ELSE 'pending' END,
        message_id=CASE WHEN meetings.starts_at=excluded.starts_at AND meetings.status!='cancelled' THEN meetings.message_id ELSE NULL END,
        attempts=CASE WHEN meetings.starts_at=excluded.starts_at AND meetings.status!='cancelled' THEN meetings.attempts ELSE 0 END
      WHERE meetings.status!='sending' RETURNING *
    ), removed AS (
      DELETE FROM meeting_dates USING previous WHERE meeting_dates.channel_id=$1 AND previous.starts_at>$7
        AND meeting_dates.meeting_date=to_char(to_timestamp(previous.starts_at/1000.0) AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD')
        AND meeting_dates.meeting_date!=$8 AND EXISTS(SELECT 1 FROM saved)
    ), remembered AS (
      INSERT INTO meeting_dates SELECT channel_id,$8 FROM saved ON CONFLICT DO NOTHING
    ) SELECT * FROM saved`).get(id,starts,remind,actor,location,ends,now,date);
    if(!row)throw new Error('提醒正在發送，請稍後再修改。');
    return row;
  }
  async cancel(id) {
    const row=await this.db.prepare(`WITH cancelled AS (
      UPDATE meetings SET status='cancelled' WHERE channel_id=$1 AND status!='sending' RETURNING *
    ), removed AS (
      DELETE FROM meeting_dates USING cancelled WHERE meeting_dates.channel_id=$1 AND cancelled.starts_at>$2
        AND meeting_dates.meeting_date=to_char(to_timestamp(cancelled.starts_at/1000.0) AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD')
    ) SELECT * FROM cancelled`).get(id,Date.now());
    return row?1:0;
  }
  async recordDates(channel) {
    return (await this.db.prepare(`SELECT meeting_date FROM meeting_dates WHERE channel_id=?
      UNION SELECT meeting_date FROM meeting_records WHERE channel_id=? ORDER BY meeting_date DESC`).all(channel,channel)).map(row=>row.meeting_date);
  }
  async setRecord(channel,date,url,actor) {
    const validDate=recordDate(date),validUrl=recordLink(url);
    (await this.db.prepare(`INSERT INTO meeting_records VALUES(?,?,?,?,?) ON CONFLICT(channel_id,meeting_date)
      DO UPDATE SET url=excluded.url,actor_id=excluded.actor_id,updated_at=excluded.updated_at`).run(channel,validDate,validUrl,actor,Date.now()));
    return this.record(channel,validDate);
  }
  async record(channel,date) {return (await this.db.prepare('SELECT * FROM meeting_records WHERE channel_id=? AND meeting_date=?').get(channel,recordDate(date)));}
  async recordForMeeting(row) {return this.record(row.channel_id,new Date(row.starts_at+8*3600000).toISOString().slice(0,10));}
}
