'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {Server}=require('socket.io');
const root=path.join(__dirname,'public');
const server=http.createServer((req,res)=>{
  let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname)}catch{return res.writeHead(400).end()}
  if(pathname==='/')pathname='/index.html';
  const file=path.resolve(root,'.'+pathname);
  if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
  fs.readFile(file,(err,data)=>{
    if(err)return res.writeHead(404).end('Not found');
    res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'}).end(data);
  });
});
const io=new Server(server,{maxHttpBufferSize:20000,cors:{origin:false}});
const rooms=new Map(),queue=[];let seq=0;
const cpuTypes=[
  {name:'堅太郎',weights:[.48,.35,.12,.05]},
  {name:'攻太郎',weights:[.19,.17,.49,.15]},
  {name:'四太郎',weights:[.17,.13,.15,.55]},
  {name:'乱太郎',weights:[.25,.25,.25,.25]},
  {name:'普太郎',weights:[.3483,.243,.2187,.19]}
];
const safe=v=>String(v||'あなた').trim().slice(0,12)||'あなた';
const human=(s,name)=>({id:s.id,name:safe(name),cpu:false,score:0,hand:null,target:null});
function bot(type){return {id:'cpu-'+crypto.randomUUID(),name:type.name,cpu:true,type:type.name,score:0,hand:null,target:null}}
function addBots(n){const shuffled=[...cpuTypes].sort(()=>Math.random()-.5);return Array.from({length:n},(_,i)=>bot(i<shuffled.length?shuffled[i]:cpuTypes[Math.floor(Math.random()*cpuTypes.length)]))}
function chooseBot(r,p){
  const type=cpuTypes.find(t=>t.name===p.type)||cpuTypes[4];
  let weights=[...type.weights];
  if(p.type==='普太郎'){const f=p.score>=10?.14:r.draws===2?.34:.19;weights=[.43*(1-f),.30*(1-f),.27*(1-f),f]}
  if(!r.allowFour){weights[3]=0}
  const total=weights.reduce((a,b)=>a+b,0);let x=Math.random()*total;
  for(let i=0;i<4;i++){x-=weights[i];if(x<0)return i}return 2;
}
function publicRoom(r){return {id:r.id,mode:r.mode,label:r.label,host:r.host,status:r.status,allowFour:r.allowFour,players:r.players.map(p=>({id:p.id,name:p.name,cpu:p.cpu,score:p.score,submitted:p.hand!==null,targeted:p.target!==null})),game:r.game,round:r.round,draws:r.draws,phase:r.phase,result:r.result,targets:r.targets||[],rockTargets:r.phase==='target'?r.players.filter(p=>p.hand===0).map(p=>({id:p.id,name:p.name})):[],resultsAt:r.resultsAt}}
function emit(r){io.to(r.id).emit('state',publicRoom(r))}
function fail(s,msg){s.emit('errorMessage',msg)}
function removeQueue(id){let i=queue.indexOf(id);if(i>=0)queue.splice(i,1)}
function drop(s){removeQueue(s.id);const id=s.data.room;if(!id)return;s.leave(id);s.data.room=null;const r=rooms.get(id);if(!r)return;const i=r.players.findIndex(p=>p.id===s.id);if(i<0)return;
  if(r.status==='waiting'){r.players.splice(i,1);if(!r.players.some(p=>!p.cpu)){rooms.delete(id);return}if(r.host===s.id)r.host=r.players.find(p=>!p.cpu).id;emit(r)}
  else if(r.status==='playing'){const old=r.players[i];r.players[i]={...old,id:'cpu-'+crypto.randomUUID(),cpu:true,type:'普太郎',name:old.name+' (CPU)'};if(r.phase==='choose'&&old.hand===null)r.players[i].hand=chooseBot(r,r.players[i]);if(r.phase==='target'&&r.targets.includes(i)&&old.target===null)r.players[i].target=randomRock(r);emit(r);maybeResolve(r)}
}
function newRoom(s,mode,label,pass,name,allowFour=true){const r={id:'room-'+(++seq),mode,label,pass,host:s.id,status:'waiting',allowFour,players:[human(s,name)],game:1,round:1,draws:0,phase:'choose',result:null,targets:[],resultsAt:null};rooms.set(r.id,r);s.join(r.id);s.data.room=r.id;emit(r);return r}
function start(r){if(r.status!=='waiting')return false;if(r.mode==='open'&&r.players.length!==5)return false;if(r.mode!=='open'&&(r.players.length<2||r.players.length>10))return false;r.status='playing';r.game=1;r.round=1;r.draws=0;nextHands(r);return true}
function nextHands(r){r.phase='choose';r.result=null;r.targets=[];r.resultsAt=null;r.players.forEach(p=>{p.target=null;p.hand=p.cpu?chooseBot(r,p):null});emit(r);maybeResolve(r)}
function randomRock(r){const ids=r.players.filter(p=>p.hand===0).map(p=>p.id);return ids[Math.floor(Math.random()*ids.length)]||null}
function maybeResolve(r){
  if(r.status!=='playing'||r.result)return;
  if(r.phase==='target'){if(r.targets.some(i=>r.players[i].target===null))return;return finalize(r,r.pending)}
  if(r.phase!=='choose'||r.players.some(p=>p.hand===null))return;
  const hands=r.players.map(p=>p.hand),delta=hands.map(()=>0),four=hands.filter(h=>h===3).length;
  let summary='',finished=true;
  if(four){
    if(four===1){const i=hands.indexOf(3);hands.forEach((_,j)=>{if(i!==j)delta[j]=2});summary=r.players[i].name+'のフォー独占！ 他の全員に2点。'}
    else{hands.forEach((h,i)=>{if(h===3)delta[i]=4});summary='フォーが'+four+'人被り！ フォーを出した全員に4点。'}
  }else{
    const distinct=[...new Set(hands)];
    if(distinct.length===1||distinct.length===3){
      r.draws++;finished=r.draws===3;
      if(finished){delta.fill(10);summary='3連続あいこ！ 全員に10点！'}
      else summary='あいこ！ '+r.draws+'連続。';
    }else{
      const [a,b]=distinct;
      const loser=(a===0&&b===1)||(a===1&&b===2)||(a===2&&b===0)?b:a;
      hands.forEach((h,i)=>{if(h===loser)delta[i]=[0,2,5][h]});
      if(loser===0){ // Paper beats rock: every winning paper player selects one rock player
        r.targets=hands.flatMap((h,i)=>h===2?[i]:[]);
        r.pending={hands,delta,summary:'パー勝利！ 各パー勝者がグーの相手を指名して5点。',finished:true};
        r.phase='target';
        r.targets.forEach(i=>{if(r.players[i].cpu)r.players[i].target=randomRock(r)});
        emit(r);return maybeResolve(r);
      }
      summary=['グー','チョキ','パー'][loser]+'の負け！ '+[0,2,5][loser]+'点。';
    }
  }
  finalize(r,{hands,delta,summary,finished});
}
function finalize(r,data){
  const {hands,delta,finished}=data;let summary=data.summary;
  if(r.phase==='target'){const details=[];r.targets.forEach(i=>{const target=r.players[i].target;const j=r.players.findIndex(p=>p.id===target&&p.hand===0);if(j>=0){delta[j]+=5;details.push(r.players[i].name+' → '+r.players[j].name)}});summary+=' '+details.join(' / ')}
  r.players.forEach((p,i)=>p.score+=delta[i]);
  const ended=r.players.some(p=>p.score>=13);
  r.phase='result';r.result={hands,delta,summary,finished,ended};r.resultsAt=Date.now();emit(r);
  setTimeout(()=>{if(r.status!=='playing'||r.phase!=='result')return;if(ended){r.status='ended';emit(r);return}if(finished){r.game++;r.round=1;r.draws=0}else r.round++;nextHands(r)},5500);
}
function matchQueue(){while(queue.length>=5){const ids=queue.splice(0,5);const ss=ids.map(id=>io.sockets.sockets.get(id)).filter(s=>s&&s.connected&&!s.data.room);if(ss.length!==5){ss.forEach(s=>queue.push(s.id));break}const r=newRoom(ss[0],'open','オープンマッチ',null,ss[0].data.name,true);for(const s of ss.slice(1)){r.players.push(human(s,s.data.name));s.join(r.id);s.data.room=r.id}start(r)}}
io.on('connection',s=>{
  s.on('openMatch',d=>{if(s.data.room||queue.includes(s.id))return fail(s,'すでに参加しています');s.data.name=safe(d?.name);queue.push(s.id);for(const id of queue)io.sockets.sockets.get(id)?.emit('queued',{count:queue.length});matchQueue()});
  s.on('cancelQueue',()=>{removeQueue(s.id);s.emit('queueCancelled')});
  s.on('cpuMatch',d=>{if(s.data.room||queue.includes(s.id))return fail(s,'先に現在の対戦を終了してください');const r=newRoom(s,'cpu','CPU対戦',null,d?.name,true);r.players.push(...addBots(4));start(r)});
  s.on('createPrivate',d=>{if(s.data.room||queue.includes(s.id))return fail(s,'先に現在の参加を終了してください');const label=String(d?.label||'').trim().slice(0,24),pass=String(d?.pass||'');if(!label||pass.length<4||pass.length>32)return fail(s,'ルーム名と4〜32文字の合言葉を入力してください');if([...rooms.values()].some(r=>r.mode==='private'&&r.label===label&&r.status==='waiting'))return fail(s,'同名の待機中ルームがあります');newRoom(s,'private',label,pass,d?.name,d?.allowFour!==false)});
  s.on('joinPrivate',d=>{if(s.data.room||queue.includes(s.id))return fail(s,'先に現在の参加を終了してください');const r=[...rooms.values()].find(r=>r.mode==='private'&&r.label===String(d?.label||'').trim()&&r.status==='waiting');if(!r||r.pass!==String(d?.pass||''))return fail(s,'ルームがないか合言葉が違います');if(r.players.length>=10)return fail(s,'満員です（最大10人）');r.players.push(human(s,d?.name));s.join(r.id);s.data.room=r.id;emit(r)});
  s.on('setCpu',count=>{const r=rooms.get(s.data.room);if(!r||r.mode!=='private'||r.host!==s.id||r.status!=='waiting')return fail(s,'ホストだけが変更できます');const n=Number(count),humans=r.players.filter(p=>!p.cpu);if(!Number.isInteger(n)||n<0||humans.length+n>10)return fail(s,'合計10人以内でCPU人数を指定してください');r.players=[...humans,...addBots(n)];emit(r)});
  s.on('startPrivate',()=>{const r=rooms.get(s.data.room);if(!r||r.mode!=='private'||r.host!==s.id)return fail(s,'ホストだけが開始できます');if(!start(r))fail(s,'2〜10人で開始できます')});
  s.on('hand',h=>{const r=rooms.get(s.data.room);if(!r||r.status!=='playing'||r.phase!=='choose')return;const p=r.players.find(p=>p.id===s.id);if(!p||p.hand!==null||!Number.isInteger(h)||h<0||h>3||(h===3&&!r.allowFour))return;p.hand=h;emit(r);maybeResolve(r)});
  s.on('target',id=>{const r=rooms.get(s.data.room);if(!r||r.status!=='playing'||r.phase!=='target')return;const i=r.players.findIndex(p=>p.id===s.id);if(!r.targets.includes(i)||r.players[i].target!==null)return;if(!r.players.some(p=>p.id===id&&p.hand===0))return fail(s,'グーの相手を選んでください');r.players[i].target=id;emit(r);maybeResolve(r)});
  s.on('leave',()=>{drop(s);s.emit('left')});s.on('disconnect',()=>drop(s));
});
const port=process.env.PORT||3000;server.listen(port,()=>console.log('しんたろうジャンケン2 http://localhost:'+port));
