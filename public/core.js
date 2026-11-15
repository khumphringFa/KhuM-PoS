export const money = n => new Intl.NumberFormat('en-BD',{style:'currency',currency:'BDT',currencyDisplay:'narrowSymbol'}).format(n/100);
export const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dhaka',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export function integer(n,min=0,max=1000000000){if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('Invalid number');return n;}
export function lineTotal(price,qty){integer(price);integer(qty,1);return Math.round(price*qty/1000);}
export function totals(lines,discount=0){integer(discount);const subtotal=lines.reduce((s,l)=>s+lineTotal(l.price,l.qty),0);integer(subtotal);if(discount>subtotal)throw Error('Discount exceeds subtotal');return {subtotal,discount,total:subtotal-discount};}
export function validateCart(cart,products,date=today()){
 if(!Array.isArray(cart)||!cart.length||cart.length>40)throw Error('Add between 1 and 40 items');
 const seen=new Set();return cart.map(l=>{if(seen.has(l.product_id))throw Error('Duplicate product');seen.add(l.product_id);integer(l.qty,1);const p=products.find(p=>p.id===l.product_id);if(!p)throw Error('Product no longer exists');if(p.expiry&&p.expiry<date)throw Error(`${p.name} is expired`);if(p.stock<l.qty)throw Error(`Insufficient stock: ${p.name}`);if(l.price!==p.price)throw Error(`Price changed: ${p.name}`);return {...l,name:p.name,cost:p.cost};});
}
