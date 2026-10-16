import baseline from './generated-seed-baseline.json' with {type:'json'};
import type {SeedDefinitionInput} from './seeds.js';
/** Generated from the collector's single code catalog. Bootstrap input only. */
export function getStaticSeedBaseline():{definitions:SeedDefinitionInput[];evidence:any[];sourceHashes:Record<string,string>}{
 return structuredClone(baseline) as unknown as {definitions:SeedDefinitionInput[];evidence:any[];sourceHashes:Record<string,string>};
}
