import type { Vital } from "./model";
export const metricCatalog = [
 ["heart-rate","Puls","slag/min"],["resting-heart-rate","Vilopuls","slag/min"],
 ["hrv","HRV (SDNN)","ms"],["hrv-rmssd","HRV (RMSSD)","ms"],
 ["respiratory-rate","Andningsfrekvens","andetag/min"],["oxygen","Syremättnad","%"],
 ["vo2-max","VO₂ max","ml/kg/min"],["weight","Vikt","kg"],["temperature","Kroppstemperatur","°C"],
 ["fev1","FEV₁","L"],["fvc","FVC","L"],["pef","PEF","L/min"],
 ["steps","Steg per dag","steg"],["step-count","Steg – råmätningar","steg"],
 ["distance","Gång och löpning","km"],["active-energy","Aktiv energi","kcal"],["flights","Trappor","våningar"],
 ["sleep","Registrerad sömn",""],["sleep-awake","Vaken under sömnregistrering",""],
 ["sleep-in-bed","Tid i säng",""],["workout","Träningspass","min"],
] as const;
export type VitalSummary = {kind:string;count:number;first_at:string;last_at:string;latest:Vital};
export type VitalsOverview = {metrics:VitalSummary[];sleep_night:{day:string;seconds:number}|null};
export type HistoryCursor = {at:string;id:string};
export type VitalsPage = {samples:Vital[];next:HistoryCursor|null};
export function duration(seconds:number) {
 const minutes=Math.round(seconds/60);
 return Math.floor(minutes/60)+" tim "+minutes%60+" min";
}
export function formatVital(v:Vital) {
 if(v.value===null) return duration(Math.max(0,(Date.parse(v.end_at)-Date.parse(v.start_at))/1000));
 const unit=metricCatalog.find(([kind])=>kind===v.kind)?.[2]??v.unit;
 return (new Intl.NumberFormat("sv-SE",{maximumFractionDigits:2}).format(v.value)+" "+unit).trim();
}
export function mergeSamples(old:Vital[],page:Vital[]) {
 return [...new Map([...old,...page].map(v=>[v.id,v])).values()];
}
