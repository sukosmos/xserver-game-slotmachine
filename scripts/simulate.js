import { loadRules } from '../src/server/load-rules.js';
import { simulateFirstRound } from './simulation.js';

const trials = process.argv[2] === undefined ? 100000 : Number(process.argv[2]);
console.log(JSON.stringify(simulateFirstRound(loadRules(), { trials }), null, 2));
