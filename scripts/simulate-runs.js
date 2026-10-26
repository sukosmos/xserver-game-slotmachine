import { writeFileSync } from 'node:fs';
import { loadRules } from '../src/server/load-rules.js';
import { simulateRuns } from './run-simulation.js';

const trials = process.argv[2] === undefined ? 10000 : Number(process.argv[2]);
const result = simulateRuns(loadRules(), { trials });
const output = JSON.stringify(result, null, 2) + '\n';
if (process.argv[3]) writeFileSync(process.argv[3], output);
console.log(output);
