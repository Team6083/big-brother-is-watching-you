import {execFileSync} from 'node:child_process';

const files=execFileSync('git',['ls-files','--cached','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
if(!files.length){console.error('No staged/tracked files to audit.');process.exit(1);}
const problems=[];
for(const file of files) {
  if(/(?:^|\/)(?:node_modules|data|private)\//.test(file) || /(?:^|\/)\.env(?:\.|$)/.test(file)&&!file.endsWith('.env.example') || /\.(?:sqlite(?:-wal|-shm)?|db|log|zip|png|pem|key|p12|pfx)$/i.test(file)) {
    problems.push({file,code:'private_artifact'});continue;
  }
  const content=execFileSync('git',['show',':'+file],{encoding:'utf8',maxBuffer:4*1024*1024});
  const patterns=[
    ['private_key',/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/],
    ['discord_token',/\b[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/],
    ['make_webhook',/https:\/\/hook(?:\.[a-z0-9-]+)?\.(?:make|integromat)\.com\/[A-Za-z0-9_-]{20,}/],
    ['personal_path',/[A-Za-z]:\\(?:Users|users)\\/],
  ];
  if(file.startsWith('src/'))patterns.push(['literal_deployment_id',/["'`]\d{17,20}["'`]/]);
  for(const [code,pattern] of patterns)if(pattern.test(content))problems.push({file,code});
}
if(problems.length){console.error(JSON.stringify({event:'public_audit_failed',problems}));process.exitCode=1;}
else console.log(JSON.stringify({event:'public_audit_passed',files:files.length}));
