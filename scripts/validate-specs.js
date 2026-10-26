import { loadRules } from '../src/server/load-rules.js';
import { readDocuments, checkDocumentation, checkDocumentLinks } from './spec-checks.js';

const documents = readDocuments();
const summary = checkDocumentation(loadRules(), documents);
checkDocumentLinks(documents);
console.log(`PASS: JSON schemas, document tables, rule references and Markdown links ${JSON.stringify(summary)}`);
