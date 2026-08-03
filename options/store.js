/* ============================================================
   Options Radar — PERSISTENCE
   SQLite (node:sqlite, built in on Node 22+) with an NDJSON fallback so the module
   still works on the Node 18 baseline package.json declares.

   Why this matters: Render / DigitalOcean app filesystems are EPHEMERAL. A redeploy
   wipes local state, and for a 90-day IV baseline that is not a cosmetic loss — the
   percentile signal silently reverts to backfilled Deribit data and the native cutover
   never completes. Point OPTIONS_DB at a persistent volume.
   ============================================================ */
"use strict";
const fs=require("fs"), path=require("path");

let DatabaseSync=null;
try{ ({DatabaseSync}=require("node:sqlite")); }catch(e){ /* Node < 22 → NDJSON fallback */ }

const SCHEMA=`
CREATE TABLE IF NOT EXISTS bucket_iv (
  ts_ms INTEGER NOT NULL, underlying TEXT NOT NULL, tenor TEXT NOT NULL,
  delta_bucket TEXT NOT NULL, iv REAL NOT NULL, src TEXT NOT NULL, n_points INTEGER,
  PRIMARY KEY (ts_ms, underlying, tenor, delta_bucket)
);
CREATE INDEX IF NOT EXISTS ix_bucket ON bucket_iv (underlying, tenor, delta_bucket, ts_ms);

CREATE TABLE IF NOT EXISTS snapshots (
  ts_ms INTEGER NOT NULL, venue TEXT NOT NULL, underlying TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (ts_ms, venue, underlying)
);

CREATE TABLE IF NOT EXISTS signals (
  ts_ms INTEGER NOT NULL, id TEXT NOT NULL, side TEXT NOT NULL, score REAL,
  payload TEXT NOT NULL,
  PRIMARY KEY (ts_ms, id, side)
);
CREATE INDEX IF NOT EXISTS ix_sig_ts ON signals (ts_ms);

CREATE TABLE IF NOT EXISTS rejections (
  ts_ms INTEGER NOT NULL, id TEXT NOT NULL, stage TEXT, reason TEXT, detail TEXT,
  PRIMARY KEY (ts_ms, id)
);
CREATE INDEX IF NOT EXISTS ix_rej_id ON rejections (id, ts_ms);
`;

function open(dir,opts){
  opts=opts||{};
  const dbPath=opts.file||process.env.OPTIONS_DB||path.join(dir,"options-radar.db");
  if(DatabaseSync&&!opts.forceFallback){
    try{
      fs.mkdirSync(path.dirname(dbPath),{recursive:true});
      const db=new DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode=WAL;");
      db.exec(SCHEMA);
      return sqliteStore(db,dbPath);
    }catch(e){ /* fall through to NDJSON */ }
  }
  return ndjsonStore(path.join(path.dirname(dbPath),"options-radar-data"));
}

function sqliteStore(db,dbPath){
  const ins=(sql)=>db.prepare(sql);
  const qBucket=ins(`INSERT OR REPLACE INTO bucket_iv (ts_ms,underlying,tenor,delta_bucket,iv,src,n_points) VALUES (?,?,?,?,?,?,?)`);
  const qSnap  =ins(`INSERT OR REPLACE INTO snapshots (ts_ms,venue,underlying,payload) VALUES (?,?,?,?)`);
  const qSig   =ins(`INSERT OR REPLACE INTO signals (ts_ms,id,side,score,payload) VALUES (?,?,?,?,?)`);
  const qRej   =ins(`INSERT OR REPLACE INTO rejections (ts_ms,id,stage,reason,detail) VALUES (?,?,?,?,?)`);
  return {
    kind:"sqlite", path:dbPath,
    putBucketIV(r){ qBucket.run(r.ts_ms,r.underlying,r.tenor,r.delta_bucket,r.iv,r.src,r.n_points||0); },
    // History for the IV-percentile signal. Returns both the values and whether ANY of them
    // came from the Deribit backfill, which is what drives the "scored on backfilled data" badge.
    bucketHistory(underlying,tenor,delta_bucket,sinceMs){
      const rows=db.prepare(`SELECT iv,src FROM bucket_iv WHERE underlying=? AND tenor=? AND delta_bucket=? AND ts_ms>=? ORDER BY ts_ms`)
        .all(underlying,tenor,delta_bucket,sinceMs||0);
      return {iv:rows.map(r=>r.iv), backfilled:rows.some(r=>r.src!=="coindcx"), n:rows.length,
              nativeN:rows.filter(r=>r.src==="coindcx").length};
    },
    putSnapshot(s){ qSnap.run(s.ts_ms,s.venue,s.underlying,JSON.stringify(s)); },
    snapshots(underlying,fromMs,toMs){
      return db.prepare(`SELECT payload FROM snapshots WHERE underlying=? AND ts_ms BETWEEN ? AND ? ORDER BY ts_ms`)
        .all(underlying,fromMs||0,toMs||Date.now()+1).map(r=>JSON.parse(r.payload));
    },
    putSignal(sig){ qSig.run(sig.ts_ms,sig.id,sig.side,sig.score_10,JSON.stringify(sig)); },
    signalsSince(ms){ return db.prepare(`SELECT payload FROM signals WHERE ts_ms>=? ORDER BY ts_ms DESC`).all(ms).map(r=>JSON.parse(r.payload)); },
    putRejection(r){ qRej.run(r.ts_ms,r.id,r.stage,r.reason,JSON.stringify(r.detail||{})); },
    lastRejection(id){
      const r=db.prepare(`SELECT ts_ms,stage,reason,detail FROM rejections WHERE id=? ORDER BY ts_ms DESC LIMIT 1`).get(id);
      return r?{...r,detail:safeParse(r.detail)}:null;
    },
    close(){ try{db.close();}catch(e){} }
  };
}

/* NDJSON fallback — same interface, append-only files. Keeps the module usable on Node 18,
   at the cost of full-file scans on read. */
function ndjsonStore(dir){
  fs.mkdirSync(dir,{recursive:true});
  const f=n=>path.join(dir,n+".ndjson");
  const append=(n,o)=>{try{fs.appendFileSync(f(n),JSON.stringify(o)+"\n");}catch(e){}};
  const readAll=(n)=>{try{return fs.readFileSync(f(n),"utf8").split("\n").filter(Boolean).map(safeParse).filter(Boolean);}catch(e){return [];}};
  return {
    kind:"ndjson", path:dir,
    putBucketIV(r){ append("bucket_iv",r); },
    bucketHistory(underlying,tenor,delta_bucket,sinceMs){
      const rows=readAll("bucket_iv").filter(r=>r.underlying===underlying&&r.tenor===tenor&&
        r.delta_bucket===delta_bucket&&r.ts_ms>=(sinceMs||0));
      return {iv:rows.map(r=>r.iv), backfilled:rows.some(r=>r.src!=="coindcx"), n:rows.length,
              nativeN:rows.filter(r=>r.src==="coindcx").length};
    },
    putSnapshot(s){ append("snapshots",s); },
    snapshots(underlying,fromMs,toMs){
      return readAll("snapshots").filter(s=>s.underlying===underlying&&s.ts_ms>=(fromMs||0)&&s.ts_ms<=(toMs||Date.now()+1))
        .sort((a,b)=>a.ts_ms-b.ts_ms);
    },
    putSignal(sig){ append("signals",sig); },
    signalsSince(ms){ return readAll("signals").filter(s=>s.ts_ms>=ms).sort((a,b)=>b.ts_ms-a.ts_ms); },
    putRejection(r){ append("rejections",r); },
    lastRejection(id){
      const rows=readAll("rejections").filter(r=>r.id===id).sort((a,b)=>b.ts_ms-a.ts_ms);
      return rows[0]||null;
    },
    close(){}
  };
}
function safeParse(s){try{return typeof s==="string"?JSON.parse(s):s;}catch(e){return null;}}

module.exports={open,hasSqlite:()=>!!DatabaseSync};
