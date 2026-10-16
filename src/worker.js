import { SyncError, discordError, backoff } from './errors.js';
import { initialTask } from './proposal.js';

export class Worker {
  constructor({ store, config, discord, send, log, now = Date.now, random = Math.random }) {
    Object.assign(this, { store, config, discord, send, log, now, random });
    this.running = false;
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    let row;
    try {
      row = await this.store.claim(this.config, this.now());
      if (!row) return;
      if (row.status === 'succeeded') await this.notify(row);
      else await this.sync(row);
    } finally {
      try { if (row) await this.store.release(row); }
      finally { this.running = false; }
    }
  }
  async sync(row) {
    if (!row.payload) {
      if (row.fetch_attempts >= 5) return this.fail(row, 'starter_retries_exhausted');
      await this.store.update(row, { fetch_attempts: row.fetch_attempts + 1 });
      let proposal;
      try { proposal = await this.discord.fetchProposal(row.thread_id); }
      catch (error) {
        return this.retryOrFail(row, error instanceof SyncError ? error : discordError(error), row.fetch_attempts);
      }
      await this.store.update(row, { payload: JSON.stringify(proposal) });
    }
    if (row.send_attempts >= 5) return this.fail(row, 'confirmation_retries_exhausted');
    // Persist uncertainty BEFORE performing the external side effect.
    await this.store.update(row, { status: 'awaiting_confirmation', send_attempts: row.send_attempts + 1 });
    let ack;
    try { ack = await this.send(JSON.parse(row.payload)); }
    catch (error) {
      return this.retryOrFail(row, error instanceof SyncError ? error : new SyncError('make_request_failed'), row.send_attempts);
    }
    await this.store.update(row, {
      status: 'succeeded', ack: JSON.stringify(ack), last_error: null, confirmed_at: this.now(),
      task_snapshot: JSON.stringify(initialTask(JSON.parse(row.payload), ack)), next_attempt_at: 0,
    });
    this.log('proposal_confirmed', { thread_id: row.thread_id });
    await this.notify(row);
  }
  async fail(row, code) {
    await this.store.update(row, { status: 'failed', last_error: code });
    this.log('proposal_failed', { thread_id: row.thread_id, code });
  }
  async retryOrFail(row, error, attempt) {
    if (!error.retryable || attempt >= 5) return this.fail(row, error.code);
    await this.store.update(row, { last_error: error.code,
      next_attempt_at: this.now() + Math.max(backoff(attempt, this.random), error.retryAfterMs) });
    this.log('proposal_retry_scheduled', { thread_id: row.thread_id, code: error.code, attempts: attempt });
  }
  async notify(row) {
    if (row.status !== 'succeeded' || row.notification_status !== 'pending') return;
    if (!this.config.notify) {
      await this.store.update(row, { notification_status: 'skipped', notification_error: 'notification_disabled' });
      return;
    }
    if (row.notification_attempts >= 3) {
      await this.store.update(row, { notification_status: 'failed', notification_error: 'notification_retries_exhausted' });
      return;
    }
    await this.store.update(row, { notification_attempts: row.notification_attempts + 1 });
    let result;
    try { result = await this.discord.notify(row.thread_id, JSON.parse(row.ack)); }
    catch {
      await this.store.update(row, {
        notification_status: row.notification_attempts >= 3 ? 'failed' : 'pending',
        notification_error: 'discord_notification_failed',
        next_attempt_at: this.now() + backoff(row.notification_attempts, this.random),
      });
      this.log('notification_failed', { thread_id: row.thread_id, code: 'discord_notification_failed' });
      return;
    }
    await this.store.update(row, {
      notification_status: result.skipped ? 'skipped' : 'sent',
      notification_message_id: result.id ?? null, notification_error: result.skipped ? result.code : null,
    });
  }
}
