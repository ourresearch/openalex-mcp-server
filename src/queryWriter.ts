/** Entry for the openalex-query-writer Worker (oxjob #1494); everything else is in queryText.ts. */
import { handle, type QueryWriterEnv } from "./queryText";

export default {
  fetch(req: Request, env: QueryWriterEnv): Promise<Response> {
    return handle(req, env);
  },
};
