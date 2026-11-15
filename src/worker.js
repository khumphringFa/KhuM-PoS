import {createRemoteJWKSet,jwtVerify} from 'jose';
import {integer,totals,validateCart,today} from '../public/core.js';
const keys=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(b=>b.toString(16).padStart(2,'0')).join('');
const token=()=>crypto.randomUUID()+crypto.randomUUID();
const now=()=>Math.floor(Date.now()/1000);
const text=(s,max=120)=>{if(typeof s!=='string'||!s.trim()||s.length>max)fail('Invalid text');return s.trim();};
const email=s=>{s=text(s,254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))fail('Invalid email');return s;};
async function body(req){if(Number(req.headers.get('Content-Length'))>100000)fail('Request too large',413);const s=await req.text();if(s.length>100000)fail('Request too large',413);try{return JSON.parse(s);}catch{fail('Invalid JSON');}}
const stmt=(env,sql,...args)=>env.DB.prepare(sql).bind(...args);
async function audit(env,user,action,shop=null){await stmt(env,'INSERT INTO audit VALUES(?,?,?,?,?)',crypto.randomUUID(),user,action,shop,new Date().toISOString()).run();}
async function session(env,uid){const raw=token();await stmt(env,'INSERT INTO sessions VALUES(?,?,?)',await hash(raw),uid,now()+7*86400).run();return raw;}
async function identity(req,env){const raw=req.headers.get('Authorization')?.replace(/^Bearer /,'');if(!raw)fail('Please sign in',401);const u=await stmt(env,'SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires>?',await hash(raw),now()).first();if(!u)fail('Session expired; sign in again',401);return {...u,master:!!env.MASTER_GOOGLE_SUB&&u.id===env.MASTER_GOOGLE_SUB};}
async function access(env,u,shop,owner=false){const s=await stmt(env,'SELECT * FROM shops WHERE id=?',shop).first();if(!s)fail('Shop not found',404);if(!s.active&&!u.master)fail('Shop is suspended',403);const m=await stmt(env,'SELECT role FROM members WHERE shop_id=? AND user_id=?',shop,u.id).first();if(!u.master&&(!m||(owner&&m.role!=='owner')))fail('Access denied',403);return {...s,role:u.master?'master':m.role};}
async function rate(req,env){const key=req.headers.get('CF-Connecting-IP')||'local';const window=Math.floor(now()/600);await stmt(env,'INSERT INTO login_limits VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END, window=excluded.window',key,window).run();const r=await stmt(env,'SELECT count FROM login_limits WHERE key=?',key).first();if(r.count>40)fail('Too many login attempts. Try again later.',429);}
export async function route(req,env){
 const url=new URL(req.url),path=url.pathname,method=req.method;
 if(path==='/api/config')return json({googleClientId:env.GOOGLE_CLIENT_ID||'',configured:!!env.GOOGLE_CLIENT_ID,masterConfigured:!!env.MASTER_GOOGLE_SUB});
 if(!env.DB)fail('Database not configured',503);
 if(path==='/api/auth/google'&&method==='POST'){
  await rate(req,env);if(!env.GOOGLE_CLIENT_ID)fail('Google sign-in is not configured',503);const b=await body(req);
  let p;try{p=(await jwtVerify(b.credential,keys,{issuer:['https://accounts.google.com','accounts.google.com'],audience:env.GOOGLE_CLIENT_ID,algorithms:['RS256']})).payload;}catch{fail('Invalid Google credential',401);}
  if(p.email_verified!==true||!p.sub||!p.email)fail('Verified Google account required',401);
  await stmt(env,'INSERT INTO users VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name',p.sub,p.email.toLowerCase(),p.name||p.email).run();
  await stmt(env,"INSERT OR IGNORE INTO members SELECT shop_id,?, 'cashier' FROM invites WHERE email=?",p.sub,p.email.toLowerCase()).run();
  await stmt(env,'DELETE FROM invites WHERE email=?',p.email.toLowerCase()).run();
  return json({token:await session(env,p.sub)});
 }
 if(path==='/api/auth/device/start'&&method==='POST'){await rate(req,env);const secret=token(),code=crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase();await stmt(env,'INSERT INTO devices VALUES(?,?,NULL,?)',await hash(secret),code,now()+600).run();return json({secret,code});}
 if(path==='/api/auth/device/poll'&&method==='POST'){const b=await body(req);const d=await stmt(env,'SELECT * FROM devices WHERE secret_hash=? AND expires>?',await hash(text(b.secret,100)),now()).first();if(!d)fail('Device link expired',410);if(!d.user_id)return json({pending:true});const results=await env.DB.batch([stmt(env,'DELETE FROM devices WHERE secret_hash=? AND user_id=? RETURNING user_id',d.secret_hash,d.user_id)]);if(!results[0].results.length)fail('Device already linked',410);return json({token:await session(env,d.user_id)});}
 const u=await identity(req,env);
 if(path==='/api/auth/logout'&&method==='POST'){await stmt(env,'DELETE FROM sessions WHERE hash=?',await hash(req.headers.get('Authorization').slice(7))).run();return json({ok:true});}
 if(path==='/api/auth/device/approve'&&method==='POST'){const b=await body(req);const r=await stmt(env,'UPDATE devices SET user_id=? WHERE code=? AND expires>? AND user_id IS NULL',u.id,text(b.code,12),now()).run();if(!r.meta.changes)fail('Invalid or expired device code');return json({ok:true});}
 if(path==='/api/me')return json({user:u,shops:u.master?(await stmt(env,"SELECT *, 'master' AS role FROM shops ORDER BY created_at DESC").all()).results:(await stmt(env,'SELECT s.*,m.role FROM shops s JOIN members m ON s.id=m.shop_id WHERE m.user_id=? ORDER BY s.created_at DESC',u.id).all()).results});
 if(path==='/api/shops'&&method==='POST'){const b=await body(req);if(b.consent!==true)fail('Platform storage disclosure must be accepted');const id=crypto.randomUUID();await env.DB.batch([stmt(env,'INSERT INTO shops(id,name,address,phone,created_at) VALUES(?,?,?,?,?)',id,text(b.name),String(b.address||'').slice(0,200),String(b.phone||'').slice(0,30),new Date().toISOString()),stmt(env,"INSERT INTO members VALUES(?,?,'owner')",id,u.id)]);await audit(env,u.id,'create_shop',id);return json({id},201);}
 if(path==='/api/admin'&&method==='GET'){if(!u.master)fail('Master administrator required',403);await audit(env,u.id,'view_platform');return json({shops:(await stmt(env,'SELECT s.*, (SELECT count(*) FROM members m WHERE m.shop_id=s.id) members, (SELECT count(*) FROM sales a WHERE a.shop_id=s.id) sales, (SELECT coalesce(sum(total),0) FROM sales a WHERE a.shop_id=s.id) revenue FROM shops s ORDER BY created_at DESC').all()).results,audit:(await stmt(env,'SELECT * FROM audit ORDER BY created_at DESC LIMIT 100').all()).results});}
 const match=path.match(/^\/api\/shops\/([^/]+)(?:\/(.*))?$/);if(!match)fail('Not found',404);const shop=match[1],resource=match[2]||'';
 const owner=['products','members','settings','status'].includes(resource)&&method!=='GET';const s=await access(env,u,shop,owner);
 if(resource==='status'&&method==='POST'){if(!u.master)fail('Master administrator required',403);const b=await body(req);await stmt(env,'UPDATE shops SET active=? WHERE id=?',b.active===true?1:0,shop).run();await audit(env,u.id,'change_shop_status',shop);return json({ok:true});}
 if(resource==='settings'&&method==='POST'){const b=await body(req);await stmt(env,'UPDATE shops SET name=?,address=?,phone=? WHERE id=?',text(b.name),String(b.address||'').slice(0,200),String(b.phone||'').slice(0,30),shop).run();return json({ok:true});}
 if(resource==='members'&&method==='GET'){if(!u.master&&s.role!=='owner')fail('Owner required',403);return json({members:(await stmt(env,'SELECT u.email,u.name,m.role,m.user_id FROM members m JOIN users u ON u.id=m.user_id WHERE m.shop_id=?',shop).all()).results,invites:(await stmt(env,'SELECT email FROM invites WHERE shop_id=?',shop).all()).results});}
 if(resource==='members'&&method==='POST'){const b=await body(req),e=email(b.email);const person=await stmt(env,'SELECT id FROM users WHERE email=?',e).first();if(person)await stmt(env,"INSERT OR IGNORE INTO members VALUES(?,?,'cashier')",shop,person.id).run();else await stmt(env,'INSERT OR IGNORE INTO invites VALUES(?,?)',shop,e).run();await audit(env,u.id,'invite_cashier',shop);return json({ok:true});}
 if(resource==='members'&&method==='DELETE'){const b=await body(req);await env.DB.batch([stmt(env,"DELETE FROM members WHERE shop_id=? AND user_id=? AND role='cashier'",shop,String(b.user_id||'')),stmt(env,'DELETE FROM invites WHERE shop_id=? AND email=?',shop,String(b.email||'').toLowerCase())]);await audit(env,u.id,'remove_cashier',shop);return json({ok:true});}
 if(resource==='snapshot'&&method==='GET'){if(u.master)await audit(env,u.id,'view_shop_data',shop);return json({shop:s,products:(await stmt(env,'SELECT * FROM products WHERE shop_id=? ORDER BY name',shop).all()).results,sales:(await stmt(env,'SELECT * FROM sales WHERE shop_id=? ORDER BY received_at DESC LIMIT 500',shop).all()).results});}
 if(resource==='products'&&method==='POST'){
  const b=await body(req);const p={id:b.id?text(b.id,50):crypto.randomUUID(),name:text(b.name),category:text(b.category,50),unit:text(b.unit,20),barcode:String(b.barcode||'').slice(0,80),expiry:String(b.expiry||''),price:integer(b.price),cost:integer(b.cost),stock:integer(b.stock),low_stock:integer(b.low_stock)};
  if(p.expiry&&(!/^\d{4}-\d{2}-\d{2}$/.test(p.expiry)||Number.isNaN(Date.parse(p.expiry))))fail('Invalid expiry');
  if(b.version){const r=await stmt(env,'UPDATE products SET name=?,category=?,unit=?,barcode=?,expiry=?,price=?,cost=?,stock=?,low_stock=?,version=version+1 WHERE shop_id=? AND id=? AND version=?',p.name,p.category,p.unit,p.barcode,p.expiry,p.price,p.cost,p.stock,p.low_stock,shop,p.id,integer(b.version,1)).run();if(!r.meta.changes)fail('Stock changed on another device. Refresh and edit again.',409);}
  else await stmt(env,'INSERT INTO products(id,shop_id,name,category,unit,barcode,expiry,price,cost,stock,low_stock) VALUES(?,?,?,?,?,?,?,?,?,?,?)',p.id,shop,p.name,p.category,p.unit,p.barcode,p.expiry,p.price,p.cost,p.stock,p.low_stock).run();await audit(env,u.id,'save_product',shop);return json({ok:true,id:p.id});
 }
 if(resource==='sales'&&method==='POST'){
  const b=await body(req),id=text(b.id,50);const existing=await stmt(env,'SELECT * FROM sales WHERE shop_id=? AND id=?',shop,id).first();if(existing)return json({sale:existing,duplicate:true});
  if(!['Cash','Card','Mobile'].includes(b.payment))fail('Invalid payment');if(!Array.isArray(b.lines)||!b.lines.length||b.lines.length>40)fail('Invalid sale lines');
  const products=(await stmt(env,'SELECT * FROM products WHERE shop_id=?',shop).all()).results;
  let lines;try{lines=validateCart(b.lines,products,today());}catch(e){fail(e.message,409);}const t=totals(lines,integer(b.discount));if(t.total!==b.total)fail('Sale total differs from server calculation',409);integer(b.tendered,t.total);
  const created=String(b.created_at);if(!Number.isFinite(Date.parse(created))||Date.parse(created)>Date.now()+300000)fail('Invalid sale date');
  try{await env.DB.batch([stmt(env,'INSERT INTO sales VALUES(?,?,?,?,?,?,?,?,?,?)',id,shop,u.id,created,new Date().toISOString(),b.payment,t.subtotal,t.discount,t.total,b.tendered),...lines.map(l=>stmt(env,'INSERT INTO sale_lines VALUES(?,?,?,?,?,?,?)',shop,id,l.product_id,l.name,l.qty,l.price,l.cost))]);}catch(err){const duplicate=await stmt(env,'SELECT * FROM sales WHERE shop_id=? AND id=?',shop,id).first();if(duplicate)return json({sale:duplicate,duplicate:true});fail('Sale conflict: stock, price or expiry changed. Review this pending sale.',409);}
  return json({sale:await stmt(env,'SELECT * FROM sales WHERE shop_id=? AND id=?',shop,id).first()},201);
 }
 if(resource.startsWith('sales/')&&method==='GET'){const id=resource.slice(6);const sale=await stmt(env,'SELECT * FROM sales WHERE shop_id=? AND id=?',shop,id).first();if(!sale)fail('Receipt not found',404);return json({sale,lines:(await stmt(env,'SELECT * FROM sale_lines WHERE shop_id=? AND sale_id=?',shop,id).all()).results});}
 fail('Not found',404);
}
export default {async fetch(req,env){
 const url=new URL(req.url);if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(req);
 const origin=req.headers.get('Origin');const allowed=new Set([url.origin,env.APP_ORIGIN,env.ANDROID_ORIGIN].filter(Boolean));
 if(origin&&!allowed.has(origin))return json({error:'Origin not allowed'},403);
 const cors=origin?{'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type'}:{};
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 let res;try{res=await route(req,env);}catch(e){if(e.message==='Invalid number'||e.message==='Discount exceeds subtotal')e.status=400;if(!e.status)console.error('API error',e.message);res=json({error:e.status?e.message:'Server error. Please try again.'},e.status||500);}
 for(const [k,v]of Object.entries(cors))res.headers.set(k,v);return res;
},async scheduled(_event,env){await env.DB.batch([stmt(env,'DELETE FROM sessions WHERE expires<?',now()),stmt(env,'DELETE FROM devices WHERE expires<?',now()),stmt(env,'DELETE FROM login_limits WHERE window<?',Math.floor(now()/600)-1)]);}};
