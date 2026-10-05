# Galaxy Conquest

A room-code multiplayer strategy game for 2–8 players. The existing game rules, artwork, and interface are preserved. Netlify Functions handle game requests, and Netlify Blobs stores room state with strong consistency and conditional writes.

## Publish with Netlify Drop

1. Sign in to Netlify and open [Netlify Drop](https://app.netlify.com/drop).
2. Drag `netlify-ready-game.zip` onto the page. Netlify builds the frontend and deploys the function from the included `netlify.toml`.
3. Open the published site and share a room code with the other players.

The function uses Netlify's automatically available Blobs service. The project does not need GitHub, API keys, environment variables, or a separately configured database.

## Project contents

- `index.html`, `client.js`, `style.css` — browser game and visual design
- `netlify/functions/game.ts` — standard Netlify Function endpoint
- `game-core.js` — game rules and room-state helper kept outside the functions directory
- `netlify.toml`, `package.json`, `package-lock.json` — deploy and build configuration

The browser calls `/.netlify/functions/game` directly. Rooms and the ten-round game loop behave as before; player clients poll for room updates while each function invocation reads or conditionally updates the strongly consistent room record.
