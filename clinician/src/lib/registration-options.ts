import type { Kind } from "./model";

export type Choice = string | { value: string; label: string };

export const registrationTitles = {
  lab: ["Blodprover", "Provuppföljning"],
  vaccination: ["Vaccination"],
  imaging: ["Bildutlåtande"],
} satisfies Record<Kind, string[]>;

export const registrationSources = {
  lab: ["SYNLAB", "Unilabs", "Karolinska Universitetslaboratoriet", "Regionens laboratorium", "Patientens medhavda provsvar"],
  vaccination: ["Vaccinerat på mottagningen", "Vaccinationskort", "Journaluppgift", "Patientens uppgift"],
  imaging: ["Bildutlåtande från radiolog", "Journaluppgift", "Patientens medhavda utlåtande"],
} satisfies Record<Kind, string[]>;

export const vaccinationLocations = ["GoHealth", "Vårdcentral", "Vaccinationsmottagning", "Sjukhus", "Elevhälsan", "Utland"];

export const imagingBodyParts = [
  "Hjärna", "Huvud och hals", "Thorax", "Buk", "Bäcken", "Buk och bäcken",
  "Halsrygg", "Bröstrygg", "Ländrygg", "Helrygg", "Axel", "Armbåge", "Hand och handled",
  "Höft", "Knä", "Fot och fotled", "Övre extremitet", "Nedre extremitet", "Helkropp",
];

export const qualitativeLabResults = ["Positivt", "Negativt", "Påvisat", "Ej påvisat", "Gränsvärde"];

// Categories from https://www.folkhalsomyndigheten.se/vara-amnesomraden/vaccinationer/vaccinationer-a-o/
// and common product names, including products found in historical records.
// These are choices for documenting a dose already given. The options do not set a schedule.
type VaccineGroup = { type: string; numbered: number; booster?: boolean; products?: readonly string[] };
const vaccineGroups: readonly VaccineGroup[] = [
  { type: "Bältros", numbered: 2, products: ["Shingrix"] },
  { type: "Chikungunya", numbered: 1, products: ["Ixchiq", "Vimkunya"] },
  { type: "Covid-19", numbered: 3, booster: true, products: ["Comirnaty", "Spikevax", "Nuvaxovid", "Bimervax", "Kostaive"] },
  { type: "Denguefeber", numbered: 2, products: ["Qdenga"] },
  { type: "Difteri", numbered: 3, booster: true },
  { type: "Difteri och stelkramp", numbered: 3, booster: true, products: ["diTeBooster"] },
  { type: "Difteri, stelkramp och kikhosta", numbered: 3, booster: true, products: ["Boostrix", "Triaxis", "Infanrix"] },
  { type: "Difteri, stelkramp, kikhosta och polio", numbered: 3, booster: true, products: ["Boostrix Polio", "Repevax", "Tetravac"] },
  { type: "Difteri, stelkramp, kikhosta, polio och Hib", numbered: 3, booster: true, products: ["Pentavac"] },
  { type: "Difteri, stelkramp, kikhosta, polio, Hib och hepatit B", numbered: 3, booster: true, products: ["Hexyon", "Infanrix hexa", "Vaxelis"] },
  { type: "Gula febern", numbered: 1, products: ["Stamaril"] },
  { type: "Hepatit A", numbered: 2, booster: true, products: ["Avaxim", "Havrix", "Vaqta"] },
  { type: "Hepatit B", numbered: 4, booster: true, products: ["Engerix-B", "HBVAXPRO", "Fendrix", "Heplisav B"] },
  { type: "Hepatit A och B", numbered: 4, booster: true, products: ["Twinrix", "Ambirix"] },
  { type: "Hib", numbered: 3, booster: true, products: ["Act-HIB", "Hiberix"] },
  { type: "HPV", numbered: 3, products: ["Gardasil 9", "Gardasil", "Cervarix"] },
  { type: "Influensa", numbered: 2, booster: true, products: ["Vaxigrip", "Influvac", "Fluarix", "Fluenz", "Efluelda", "Fluad", "Flucelvax"] },
  { type: "Japansk encefalit", numbered: 2, booster: true, products: ["Ixiaro"] },
  { type: "Kikhosta", numbered: 3, booster: true },
  { type: "Kolera", numbered: 3, booster: true, products: ["Dukoral", "Vaxchora"] },
  { type: "Meningokocker ACWY", numbered: 2, booster: true, products: ["Nimenrix", "Menveo", "MenQuadfi"] },
  { type: "Meningokocker B", numbered: 3, booster: true, products: ["Bexsero", "Trumenba"] },
  { type: "Mpox", numbered: 2, products: ["Imvanex", "Jynneos"] },
  { type: "Mässling", numbered: 2 },
  { type: "Mässling, påssjuka och röda hund (MPR)", numbered: 2, products: ["Priorix", "M-M-RVAXPRO"] },
  { type: "MPR och vattkoppor (MPRV)", numbered: 2, products: ["Priorix-Tetra", "ProQuad"] },
  { type: "Pneumokocker", numbered: 4, booster: true, products: ["Prevenar 13", "Prevenar 20", "Vaxneuvance", "Synflorix", "Pneumovax", "Capvaxive"] },
  { type: "Polio", numbered: 4, booster: true, products: ["Imovax Polio"] },
  { type: "Påssjuka", numbered: 2 },
  { type: "Rabies", numbered: 5, booster: true, products: ["Rabipur", "Verorab"] },
  { type: "Rotavirus", numbered: 3, products: ["Rotarix", "RotaTeq"] },
  { type: "RS-virus (RSV)", numbered: 1, products: ["Abrysvo", "Arexvy", "mResvia"] },
  { type: "Röda hund", numbered: 2 },
  { type: "Stelkramp", numbered: 3, booster: true, products: ["Tetavax"] },
  { type: "TBE", numbered: 4, booster: true, products: ["FSME-IMMUN", "FSME-IMMUN Junior", "Encepur", "Encepur Barn"] },
  { type: "Tuberkulos (BCG)", numbered: 1, products: ["BCG Vaccine AJVaccines"] },
  { type: "Tyfoidfeber", numbered: 3, booster: true, products: ["Typhim Vi", "Vivotif"] },
  { type: "Vattkoppor", numbered: 2, products: ["Varilrix", "Varivax"] },
];

export const vaccineChoices: Choice[] = vaccineGroups.flatMap(({ type, products = [] }) => [
  type,
  ...products.map((product) => ({ value: product, label: `${product} (${type})` })),
]).sort((a, b) => (typeof a === "string" ? a : a.label).localeCompare(typeof b === "string" ? b : b.label, "sv"));

// Product variations where a category-level list would offer misleading dose numbers.
const productDoseCounts: ReadonlyMap<string, number> = new Map([
  ["Ambirix", 2], ["Capvaxive", 1], ["Heplisav B", 2], ["Rotarix", 2], ["Vaxchora", 1], ["Typhim Vi", 1],
]);
const numberedDoses = ["Första dosen", "Andra dosen", "Tredje dosen", "Fjärde dosen", "Femte dosen"];

export function vaccineDoseChoices(vaccine: string): Choice[] {
  const group = vaccineGroups.find(({ type, products }) => type === vaccine || products?.includes(vaccine));
  const count = productDoseCounts.get(vaccine) ?? group?.numbered ?? numberedDoses.length;
  return [
    ...numberedDoses.slice(0, count).map((label, index) => ({ value: String(index + 1), label })),
    ...(!group || group.booster ? [{ value: "påfyllnad", label: "Påfyllnadsdos" }] : []),
    { value: "okänd", label: "Okänt dosnummer" },
  ];
}
