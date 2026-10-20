// Probe the no-new-words check (oxjob #1494): node dist/wordprobe.mjs "<typed text>" "<oql>"
import { newWords, searchStrings, typedVocabulary, words, stem } from "../../src/searchWords";

const [typed, oql] = process.argv.slice(2);
console.log("typed words:", words(typed), "stems:", words(typed).map(stem));
console.log("search strings:", searchStrings(oql));
console.log("searched words:", searchStrings(oql).flatMap(words), "stems:", searchStrings(oql).flatMap(words).map(stem));
console.log("new words:", newWords(oql, typedVocabulary([typed])));
