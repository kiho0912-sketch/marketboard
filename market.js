/**
 * Marketboard v1.1 — Vercel Node serverless route.
 * Public read-only financial data endpoints. These providers are NOT official
 * licensed redistributable APIs; providers can delay, rate-limit, or block them.
 * Do not use this route for order execution, financial decisions, or a public
 * commercial redistribution site without obtaining properly licensed data.
 */
const VALID_RANGE = {'5d':8,'1mo':28,'3mo':80,'1y':280,'3y':825,'5y':1375};
const memory = new Map();
function parseNum(value){
  if(typeof value === 'number') return Number.isFinite(value)?value:null;
  if(value===null||value===undefined)return null;
  const v=String(value).replaceAll(',','').replace(/[^\d.\-+]/g,'').trim();
  const n=Number(v);return v!==''&&Number.isFinite(n)?n:null;
}
function dateString(value){
  if(value===null||value===undefined)return '';
  const s=String(value);
  if(/^\d{8}$/.test(s))return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8);
  if(/^\d{4}-\d{2}-\d{2}/.test(s))return s.slice(0,10);
  if(/^\d{10,13}$/.test(s)){
    const d=new Date(Number(s)*(s.length===10?1000:1));
    return Number.isNaN(d.valueOf())?'':d.toISOString().slice(0,10);
  }
  return '';
}
async function fetchJson(url){
  const c=new AbortController(); const timer=setTimeout(()=>c.abort(),7000);
  try{
    const headers={'Accept':'application/json,text/plain,*/*',
      'User-Agent':'Mozilla/5.0 (compatible; Marketboard/1.1; +personal-dashboard)'};
    if(url.includes('naver.com'))headers.Referer='https://m.stock.naver.com/';
    const resp=await fetch(url,{signal:c.signal,headers});
    if(!resp.ok)throw new Error('upstream '+resp.status);
    const typ=resp.headers.get('content-type')||'';
    if(typ.includes('text/html'))throw new Error('upstream blocked');
    const body=await resp.text();
    if(body.length>1800000)throw new Error('upstream payload too large');
    return JSON.parse(body);
  }finally{clearTimeout(timer);}
}
function asList(json){
  if(Array.isArray(json))return json;
  if(Array.isArray(json?.result))return json.result;
  if(Array.isArray(json?.result?.items))return json.result.items;
  if(Array.isArray(json?.result?.list))return json.result.list;
  if(Array.isArray(json?.items))return json.items;
  if(Array.isArray(json?.list))return json.list;
  if(Array.isArray(json?.priceInfos))return json.priceInfos;
  if(Array.isArray(json?.result?.priceInfos))return json.result.priceInfos;
  return [];
}
function normalizeHistory(rows){
  const pts=[];
  for(const row of rows){
    const date=dateString(row?.localTradedAt||row?.localDate||row?.date||row?.tradingDate);
    const v=parseNum(row?.closePrice??row?.close??row?.closingPrice??row?.tradePrice);
    if(date&&v!==null&&v>0)pts.push({t:date,v});
  }
  pts.sort((a,b)=>a.t.localeCompare(b.t));
  const unique=[];for(const x of pts){if(unique.length&&unique.at(-1).t===x.t)unique[unique.length-1]=x;else unique.push(x);}
  return unique;
}
function getDirection(quote){
  const key=String(quote?.compareToPreviousPrice?.code||quote?.compareToPreviousPrice?.name||quote?.compareToPreviousPrice||quote?.compareToPreviousClosePriceSign||quote?.changeSign||'').toUpperCase();
  if(/DOWN|FALL|LOWER|DECLINE|MINUS|하락|−|▼/.test(key))return -1;
  if(/UP|RISE|HIGHER|INCREASE|PLUS|상승|\+|▲/.test(key))return 1;
  return 0;
}
function normalizeQuote(json,history){
  const q=json?.datas?.[0]||json?.result?.datas?.[0]||json?.result||json?.data||json;
  if(!q||typeof q!=='object')return null;
  let price=parseNum(q.closePrice??q.currentPrice??q.tradePrice??q.nowPrice??q.price);
  if(price===null||price<=0)return null;
  const rateOrig=parseNum(q.fluctuationsRatio??q.changeRate??q.changeRatio??q.changePercent);
  let change=parseNum(q.compareToPreviousClosePrice??q.changePrice??q.change);
  const dir=getDirection(q);
  if(change!==null&&dir!==0)change=Math.abs(change)*dir;
  if(change!==null&&dir===0&&rateOrig!==null&&rateOrig!==0)change=Math.abs(change)*Math.sign(rateOrig);
  if(change===null&&rateOrig!==null){const previous=price/(1+rateOrig/100);change=price-previous;}
  if(change===null&&history.length>1)change=price-history.at(-2).v;
  let rate=rateOrig;
  if(rate!==null&&dir!==0)rate=Math.abs(rate)*dir;
  if(rate===null&&change!==null&&price!==change)rate=(change/(price-change))*100;
  const when=q.localTradedAt||q.tradeDate||q.date||q.standardDate||q.tradeDatetime||'';
  return {price,change:change??0,changeRate:rate??0,asOf:String(when).slice(0,35)};
}
async function naverHistory(type,code,limit){
  const segments=[];
  const path=type==='index'?'index':'stock';
  // First try mobile endpoint (price includes each trading day's closing value).
  const batch=Math.min(Math.max(limit,40),1500);
  let urls=[`https://m.stock.naver.com/api/${path}/${code}/price?pageSize=${batch}&page=1`];
  if(type==='index')urls.push(`https://m.stock.naver.com/front-api/stock/domestic/index/price/list?code=${code}&page=1&pageSize=${batch}`);
  for(const url of urls){
    try{
      const first=asList(await fetchJson(url));
      if(first.length===0)continue;
      segments.push(...first);
      // If a provider enforces a pageSize cap, request a few further pages.
      if(segments.length<limit&&first.length>=20){
        const actual=Math.min(first.length,batch);
        const pages=Math.min(16,Math.ceil(limit/actual));
        for(let i=2;i<=pages;i++){
          const u=url.replace(/page=1(?!\d)/,'page='+i);
          try{const part=asList(await fetchJson(u));if(!part.length)break;segments.push(...part);if(part.length<actual||segments.length>=limit)break;}
          catch(e){break;}
        }
      }
      const arr=normalizeHistory(segments);
      if(arr.length>0)return arr.slice(-limit);
    }catch(e){/* try alternative endpoint */}
  }
  throw new Error('Naver history unavailable');
}
async function naverQuote(type,code,history){
  const u=`https://polling.finance.naver.com/api/realtime/domestic/${type}/${code}`;
  try{return normalizeQuote(await fetchJson(u),history);}catch{return null;}
}
const kosdaqCodes=new Set(['247540','196170','086520','035900','277810','000250','058470','240810','028300','068760']);
async function yahooMarket(type,code,range){
  const suffix=type==='index'?(code==='KOSPI'?'^KS11':'^KQ11'):
     code+(kosdaqCodes.has(code)?'.KQ':'.KS');
  const period=range==='5d'?'1mo':range==='3y'?'5y':range;
  async function tryYahoo(symbol){
    const j=await fetchJson('https://query1.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(symbol)+'?range='+period+'&interval=1d');
    const data=j?.chart?.result?.[0];if(!data)throw Error('Yahoo data missing');
    const values=data?.indicators?.quote?.[0]?.close||[];
    const times=data.timestamp||[];
    const pts=[];
    for(let i=0;i<times.length;i++){
      const v=parseNum(values[i]);if(v===null||v<=0)continue;
      const t=dateString(new Date(times[i]*1000).toISOString());if(t)pts.push({t,v});
    }
    if(!pts.length)throw Error('Yahoo history missing');
    const points=normalizeHistory(pts.map(x=>({localTradedAt:x.t,closePrice:x.v}))).slice(-VALID_RANGE[range]);
    const meta=data.meta||{};
    const price=parseNum(meta.regularMarketPrice)??points.at(-1).v;
    const prev=parseNum(meta.regularMarketPreviousClose??meta.previousClose??meta.chartPreviousClose)??(points.at(-2)?.v??price);
    const change=price-prev;
    const asOf=meta.regularMarketTime?new Date(meta.regularMarketTime*1000).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):points.at(-1).t;
    return {ok:true,price,change,changeRate:prev?(change/prev)*100:0,points,asOf,source:'Yahoo Finance 보조 시세 (비공식)',delayed:true};
  }
  try{return await tryYahoo(suffix);}catch(e){
    // A user-entered arbitrary 6-digit code might be listed on KOSDAQ instead.
    if(type==='stock'&&!kosdaqCodes.has(code))return tryYahoo(code+'.KQ');
    throw e;
  }
}
async function getMarket(type,code,range){
  const limit=VALID_RANGE[range];
  try{
    const pts=await naverHistory(type,code,limit);
    let quote=await naverQuote(type,code,pts);
    if(!quote){
      const price=pts.at(-1).v,prev=pts.at(-2)?.v??price,change=price-prev;
      quote={price,change,changeRate:prev?change/prev*100:0,asOf:pts.at(-1).t};
    }
    return {ok:true,...quote,points:pts,source:'네이버 금융 공개 시세 (비공식)',delayed:true};
  }catch(e){return yahooMarket(type,code,range);}
}
export default async function handler(req,res){
  if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({ok:false,error:'Method not allowed'});}
  const {type,code,range='3mo'}=req.query||{};
  if(!['stock','index'].includes(type)||!Object.hasOwn(VALID_RANGE,range)||
    !((type==='stock'&&/^\d{6}$/.test(code||''))||(type==='index'&&['KOSPI','KOSDAQ'].includes(code)))){
    return res.status(400).json({ok:false,error:'조회 조건이 올바르지 않습니다.'});
  }
  const key=type+':'+code+':'+range;
  const saved=memory.get(key);
  if(saved&&saved.expire>Date.now()){
    res.setHeader('Cache-Control','public, s-maxage=60, stale-while-revalidate=120');
    return res.status(200).json(saved.data);
  }
  try{
    const data=await getMarket(type,code,range);
    memory.set(key,{expire:Date.now()+80000,data});
    if(memory.size>400)memory.clear();
    res.setHeader('Cache-Control','public, s-maxage=60, stale-while-revalidate=120');
    return res.status(200).json(data);
  }catch(e){
    res.setHeader('Cache-Control','no-store');
    return res.status(502).json({ok:false,error:'시세 제공처 연결이 되지 않습니다. 잠시 후 다시 시도하거나 네이버 금융에서 확인하세요.'});
  }
}
