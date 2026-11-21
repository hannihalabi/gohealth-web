"use client";
import {useEffect,useState} from "react";
import type {PatientDetail,Vital} from "@/lib/model";
import {duration,formatVital,mergeSamples,metricCatalog,metricTitle,type AppDisplayValue,type HistoryCursor,type VitalSummary,type VitalsOverview,type VitalsPage} from "@/lib/vitals";
async function request(body:unknown) {
 const response=await fetch("/api/clinical",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),cache:"no-store"});
 const result=await response.json();
 if(!response.ok) throw new Error(result.error||"Mätningarna kunde inte hämtas.");
 return result;
}
const time=(date:string)=>new Date(date).toLocaleString("sv-SE");
export function VitalsWorkspace({detail,demo,onRefresh}:{detail:PatientDetail;demo:boolean;onRefresh:()=>Promise<void>}) {
 const [overview,setOverview]=useState<VitalsOverview|null>(null);
 const [error,setError]=useState("");
 const [version,setVersion]=useState(0);
 const [loading,setLoading]=useState(true);
 useEffect(()=>{
  let active=true;
  setLoading(true);setError("");setOverview(null);
  const task=demo?Promise.resolve({metrics:metricCatalog.flatMap(([kind])=>{
   const values=detail.vitals.filter(v=>v.kind===kind).sort((a,b)=>b.end_at.localeCompare(a.end_at));
   return values.length?[{kind,count:values.length,first_at:values.at(-1)!.start_at,last_at:values[0].end_at,latest:values[0]}]:[];
  }),sleep_night:null}):request({action:"vitals_overview",patientId:detail.patient.id});
  task.then(data=>{if(active)setOverview(data);}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[detail.patient.id,demo,version,detail.vitals]);
 async function refresh(){
  setLoading(true);
  try{await onRefresh();setVersion(v=>v+1);}catch{setError("Uppdateringen misslyckades. Försök igen.");setLoading(false);}
 }
 const total=overview?.metrics.reduce((n,m)=>n+m.count,0)??0;
 const first=overview?.metrics.map(m=>m.first_at).sort()[0];
 return <section className="panel">
  <div className="panel-heading"><div><h2>Hälsomätningar och historik</h2><p>Alla delade mätvärden från Apple Hälsa. Äldre mätningar kan hämtas utan datumgräns.</p></div><button type="button" className="button secondary" disabled={loading} onClick={refresh}>Uppdatera</button></div>
  {error&&<p className="alert error" role="alert">{error}</p>}
  {loading&&<p role="status">Hämtar historiköversikt…</p>}
  {overview&&<>
   <p className="muted">{total.toLocaleString("sv-SE")} delade mätningar{first?" · Historik från "+time(first):""}. Saknade värden betyder att data ännu inte har delats eller inte är tillgängliga.</p>
   {overview.sync && <p role="status" className="muted">{overview.sync.state==="complete"?"Appens senaste synkning är klar":overview.sync.state==="retrying"?"Synkningen är inte klar – appen försöker igen":"Historiken synkroniseras"} · {time(overview.sync.updated_at)}</p>}
   {!!overview.display_values?.length && <div className="app-values"><h3>Appens värden</h3><p className="muted">Visningsvärden och beräkningar från appen. Avläsningstid är skild från mättid.</p>{overview.display_values.map(value=><AppValueCard key={detail.patient.id+"-"+value.key+"-"+version} value={value} patientId={detail.patient.id} count={overview.display_series?.find(s=>s.key===value.key)?.count??1}/>)}</div>}

   {overview.metrics.map(metric=><MetricCard key={detail.patient.id+"-"+metric.kind+"-"+version} patientId={detail.patient.id} metric={metric} label={metricTitle(metric)} demo={demo} initial={detail.vitals.filter(v=>v.kind===metric.kind)} night={metric.kind==="sleep"?overview.sleep_night:null}/>)}

   <p className="muted">Råmätningar bevaras med tid, enhet, källa och definition för kommande analys. Ingen AI-analys eller överföring till en AI-tjänst sker här. Garmin-värden som saknas i Apple Hälsa kräver en separat anslutning.</p>
  </>}
 </section>;
}
function MetricCard({patientId,metric,label,demo,initial,night}:{patientId:string;metric:VitalSummary;label:string;demo:boolean;initial:Vital[];night:VitalsOverview["sleep_night"]}) {
 const [samples,setSamples]=useState<Vital[]>([]);
 const [next,setNext]=useState<HistoryCursor|null>(null);
 const [loaded,setLoaded]=useState(false);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState("");
 const [before,setBefore]=useState("");
 async function load(cursor:HistoryCursor|null=next,reset=false) {
  if(loading)return;
  setLoading(true);setError("");
  try{
   const page:VitalsPage=demo?{samples:initial,next:null}:await request({action:"vitals_page",patientId,kind:metric.kind,cursor:reset?cursor:loaded?cursor:null});
   setSamples(previous=>reset?page.samples:mergeSamples(previous,page.samples));setNext(page.next);setLoaded(true);
  }catch(e){setError(e instanceof Error?e.message:"Historiken kunde inte hämtas.");}
  finally{setLoading(false);}
 }
 const latest=metric.latest;
 return <article className="vital full-vital"><div>
  <h3>{label}</h3><strong>{night?duration(night.seconds):formatVital(latest)}</strong>
  <p>{night?"Natt till "+night.day+" · Överlappande sömnintervall räknas en gång · Europe/Stockholm":time(latest.end_at)+" · "+latest.source}</p>
  {!night&&latest.kind==="sleep"&&<p className="muted">Senaste registrerade sömnintervallet.</p>}
  <small>{metric.count.toLocaleString("sv-SE")} mätningar · {time(metric.first_at)} – {time(metric.last_at)}</small>
 </div>
 <details className="vital-history" onToggle={event=>{if(event.currentTarget.open&&!loaded&&!loading)void load();}}>
  <summary>Visa hela historiken</summary>
  {!demo&&<form className="history-date-search" onSubmit={event=>{event.preventDefault();if(before)void load({at:before+"T23:59:59.999999Z",id:"ffffffff-ffff-ffff-ffff-ffffffffffff"},true);}}>
   <label>Visa mätningar före datum (UTC)<input aria-label={"Historikdatum för "+label} type="date" value={before} onChange={event=>setBefore(event.target.value)}/></label>
   <button type="submit" className="button secondary" disabled={loading||!before}>Visa historik</button>
   <button type="button" className="text-button" disabled={loading} onClick={()=>{setBefore("");void load(null,true);}}>Visa senaste</button>
  </form>}
  <p className="muted">Visar {samples.length} inlästa råmätningar av totalt {metric.count}. Tider visas i webbläsarens tidszon. Samtidiga källor visas separat och summeras inte.</p>
  <div className="table-scroll"><table><thead><tr><th>Från – till</th><th>Värde</th><th>Källa och definition</th></tr></thead><tbody>
   {samples.map(v=><tr key={v.id}><td>{time(v.start_at)}<br/>{time(v.end_at)}</td><td>{formatVital(v)}</td><td>{v.source}<br/><small>{v.definition}{v.metadata?.user_entered===true?" · Manuellt inmatat":""}</small></td></tr>)}
  </tbody></table></div>
  {loading&&<p role="status">Hämtar…</p>}
  {((loaded&&next)||(!loaded&&error))&&<button type="button" className="button secondary" disabled={loading} onClick={()=>void load()}>{loaded?"Hämta äldre mätningar":"Försök igen"}</button>}
  {error&&<p className="alert error" role="alert">{error}</p>}
 </details></article>;
}


function AppValueCard({value,patientId,count}:{value:AppDisplayValue;patientId:string;count:number}) {
 const [items,setItems]=useState<AppDisplayValue[]>([]);
 const [cursor,setCursor]=useState<HistoryCursor|null>(null);
 const [loaded,setLoaded]=useState(false);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState("");
 async function load(){
  if(loading)return;setLoading(true);setError("");
  try{
   const result:{samples:AppDisplayValue[];next:HistoryCursor|null}=await request({action:"app_value_history",patientId,kind:value.key,cursor:loaded?cursor:null});
   setItems(old=>[...new Map([...old,...result.samples].map(v=>[v.event_id,v])).values()]);setCursor(result.next);setLoaded(true);
  }catch(e){setError(e instanceof Error?e.message:"Historiken kunde inte hämtas.");}finally{setLoading(false);}
 }
 return <article className="app-value-card"><div><h4>{value.title}</h4><strong>{value.value} <small>{value.unit}</small></strong><p className="muted">{value.section} · Avläst i appen {time(value.observed_at)}</p></div>
 <details onToggle={e=>{if(e.currentTarget.open&&!loaded&&!loading)void load();}}><summary>Historik ({count})</summary>
 <div className="table-scroll"><table><thead><tr><th>Mättid / avläsning</th><th>Värde</th><th>Källa</th></tr></thead><tbody>{items.map(item=><tr key={item.event_id}><td>{item.measured_at?time(item.measured_at):"Avläst "+time(item.observed_at)}</td><td>{item.value} {item.unit}</td><td>{item.source}</td></tr>)}</tbody></table></div>
 {loading&&<p role="status">Hämtar…</p>}
 {((loaded&&cursor)||(!loaded&&error))&&<button className="button secondary" disabled={loading} onClick={load}>{loaded?"Hämta äldre värden":"Försök igen"}</button>}
 {error&&<p role="alert">{error}</p>}
 </details></article>;
}
