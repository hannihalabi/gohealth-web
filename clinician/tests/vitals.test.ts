import {test} from "node:test";
import assert from "node:assert/strict";
import {formatVital,mergeSamples,metricCatalog} from "../src/lib/vitals";
import type {Vital} from "../src/lib/model";
const sample:Vital={id:"a",kind:"hrv",value:43.7,unit:"ms",definition:"hrv",source:"Synthetic",start_at:"2010-01-01T00:00:00Z",end_at:"2010-01-01T00:00:00Z",deleted_at:null};
test("measurements retain canonical units",()=>{
 assert.match(formatVital(sample),/43,7 ms/);
 assert.match(formatVital({...sample,kind:"oxygen",value:97,unit:"%"}),/97 %/);
 assert.match(formatVital({...sample,kind:"temperature",value:36.7,unit:"degC"}),/36,7 °C/);
});
test("history pages preserve old provenance without duplication",()=>{
 const older={...sample,id:"b",source:"Other device",start_at:"2000-01-01T00:00:00Z",end_at:"2000-01-01T00:00:00Z"};
 const result=mergeSamples([sample],[sample,older]);assert.equal(result.length,2);assert.deepEqual(result[1],older);
});
test("catalogue covers raw activity, all app quantities, sleep stages and workouts",()=>{
 const kinds=metricCatalog.map(([kind])=>kind);assert.equal(new Set(kinds).size,kinds.length);
 for(const kind of ["hrv","hrv-rmssd","respiratory-rate","oxygen","vo2-max","fev1","fvc","pef","step-count","workout","sleep-awake","sleep-in-bed"])
  assert.ok(kinds.includes(kind as typeof kinds[number]));
});


test("future app metric titles and units are rendered without catalogue changes",()=>{
 const future={...sample,kind:"future.unlisted",value:0,unit:"raw-unit",metadata:{title:"New app metric",display_unit:"new-unit"}};
 assert.equal(formatVital(future),"0 new-unit");
});
