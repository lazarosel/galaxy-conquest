import { getStore } from "@netlify/blobs";
import { createGameHandler } from "../../game-core.js";

const handler = createGameHandler({
  // Netlify provides the site credentials and storage binding at runtime.
  getStore: () => getStore({ name: "galaxy-conquest-rooms", consistency: "strong" }),
});

export default handler;
