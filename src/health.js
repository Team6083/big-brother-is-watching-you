import {createServer} from 'node:http';

export async function serveHealth({ready,alive,port=process.env.PORT,host=process.env.HOST||'0.0.0.0'}) {
  if(port===undefined || port==='')return;
  if(!/^\d+$/.test(String(port)) || Number(port)>65535)throw new Error('invalid_PORT');
  const server=createServer((req,res)=>{
    const ok=req.url==='/readyz'?ready():req.url==='/healthz'?alive():null;
    res.writeHead(ok===null?404:ok?200:503,{'content-type':'application/json'});
    res.end(JSON.stringify({status:ok===null?'not_found':ok?'ok':'unavailable'}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(port),host,resolve);});
  return {port:server.address().port,close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}
