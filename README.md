# Hold'em Night — multiplayer Texas Hold'em microservices

No-limit Texas Hold'em in the browser. Up to six players per table, real-time over WebSockets. Real-chip tables are for players only; practice tables add bots and use free chips. Each player has a profile with lifetime stats, charts and game history.

## Architecture

```
 browser ──HTTP/WS──▶ web (nginx :8080) ──/ws──────────▶ game (Node :4000) ──HTTP──▶ evaluator (Node :4001)
                      static client + gateway             lobby, tables, bots    │     hand ranking
                                  │                                              │ internal API
                                  └──/api/accounts/──▶ accounts (Node :4002) ◀───┘
                                                        users, sessions, chip bank (SQLite)
```

| Service | Path | Responsibility |
|---|---|---|
| **web** | `services/web` | nginx: serves the vanilla-JS client and proxies `/ws` (WebSocket upgrade) and `/api/game/*` to the game service. The image build compiles Tailwind CSS and bundles the three.js table with esbuild |
| **game** | `services/game` | WebSocket server. Lobby, real-chip and practice tables, no-limit betting rules (blinds, min-raise, all-ins, side pots, split pots), bots, turn timeouts, per-player game stats |
| **accounts** | `services/accounts` | Register / log in / log out, session tokens, each player's chip bank, a ledger of every change and a history of finished games, stored in SQLite (Node's built-in `node:sqlite`, on the `accounts-data` volume) |
| **evaluator** | `services/evaluator` | Stateless REST service, `POST /rank`, that picks the best 5 of 7 cards and ranks players |

At showdown the game service calls the evaluator, retrying once. If the evaluator is unreachable, the hand is cancelled and all bets are returned. Every service exposes `GET /health`, and Docker healthchecks gate startup order.

### WebSocket protocol (`/ws`, JSON)

| Client → server | Server → client |
|---|---|
| `{type:"hello", token}` | `{type:"welcome", playerId, name, chips, timing}` or `{type:"authError", message}` |
| `{type:"listTables"}` | `{type:"tables", tables:[…]}` |
| `{type:"createTable", name, buyIn?, mode?}` / `{type:"joinTable", tableId, buyIn?}` | `{type:"state", table}`: per-player view; opponents' cards stay hidden until showdown |
| `{type:"leaveTable"}` / `{type:"addBot"}` / `{type:"rebuy"}` / `{type:"startGame"}` | `{type:"left", reason?}` / `{type:"notice", message}` |
| | `{type:"account", chips}`: new bank balance after a buy-in, rebuy or cash-out |
| `{type:"action", action:"fold"\|"check"\|"call"\|"bet"\|"raise"\|"allin", amount?}` | `{type:"error", message}` |

`amount` for bet/raise is the total bet for the street ("raise **to**"). `mode` is `"normal"` (the default) or `"bot"`, and tables and table summaries carry it. `addBot` is refused at normal tables. Messages from one connection are handled in order.

### Starting a game and timings

- **The host starts the game.** Whoever creates a table hosts it; if they leave, the next human seated takes over. No cards are dealt until the host sends `startGame` (the **Start game** button), which needs at least two players with chips. Only the first hand waits for the host. After that, hands are dealt automatically, including after a pause for players to rebuy or join.
- **Turn clock**: each turn lasts `TURN_TIMEOUT_MS` (30 s by default; `0` turns it off). When it runs out the server checks for the player if it can, otherwise folds, and sends them a `notice`. The clock starts once per turn: other players joining, leaving or rebuying don't reset it.
- **Between hands**: the next hand is dealt `NEXT_HAND_DELAY_MS` (5 s by default) after the last one ends.
- **What players see**: `welcome.timing` and every `state.table.timing` carry `{turnTimeoutMs, nextHandDelayMs, reconnectGraceMs}`. State also carries the live `turnEndsIn` and `nextHandIn` (ms left, or `null`). The table screen and the lobby spell out the rules. The player to act has a draining bar under their seat, your own turn shows "Ns left" next to the action buttons (and is announced to screen readers 10 s before the end), and "Next hand in Ns" shows between hands.

### Table types

| | Real chips (`normal`) | Practice vs bots (`bot`) |
|---|---|---|
| Players | humans only; `addBot` is refused | humans and bots |
| Buy-in and rebuys | taken from the bank | free, the bank is never touched |
| Leaving | the stack is paid back to the bank | nothing is paid back |
| Profile | counts towards every money stat | listed in the history and counted as practice games/hands only |

### Accounts and chips

| Public (`/api/accounts/…` via the gateway) | |
|---|---|
| `POST /register {username, password}` | new account with the welcome chips (1,000); returns `{token, user}` |
| `POST /login {username, password}` | returns `{token, user}`; 5 failed attempts lock the name for 5 minutes |
| `POST /logout`, `GET /me`, `GET /history`, `GET /profile`, `GET /games/:id` | `Authorization: Bearer <token>` |
| `POST /buy {amount}` | buys a play-money pack of 500, 1,000 or 5,000 chips (free, no payment step) |

- **Passwords** are salted `scrypt` hashes. Session tokens are random and stored only as SHA-256 hashes; they expire after 7 days.
- **Internal API**: `POST /internal/session`, `/internal/debit`, `/internal/credit` and `/internal/game` are for the game service only. They need the shared `X-Internal-Key` (`ACCOUNTS_INTERNAL_KEY`), and the gateway answers 404 for them.
- **Buying in**: sitting down at a table takes the buy-in (200 to 5,000, default 1,000) out of your bank, and it becomes your stack. A rebuy costs the same amount again.
- **Cashing out**: leaving the table or logging out pays your stack back to the bank (after the hand, if you leave mid-hand). Closing the tab or losing the connection does the same once the seat stops being held (see *Reconnecting* below). If the game service is stopped, it cancels any hand in progress and pays every player's stack and current bets back before exiting.
- **Game records**: when a player leaves a table, the game service sends one `POST /internal/game {userId, amount, note, game}`. The accounts service pays `amount` back (always 0 for practice games) and stores the game in the same database transaction: table, type, table-session key, total buy-in and number of rebuys, cash-out, hands played and won, biggest single-hand win, and a hand log (up to the last 500 hands: your cards, the board, whether you folded, what you showed, the pot, winners and your chips won or lost). A sitting where no hand was dealt is paid back but not recorded. Internal requests may be up to 1 MB because of the hand log; public ones stay at 8 KB.
- **Game details** (`GET /games/:id`): the game with its hand log, every player's totals at that table session (summed over each time they sat down), and for real-chip games a `settlement`: the transfers, in chips, that square everyone up (the biggest loser pays the biggest winner first, so at most one transfer fewer than there are players). It also gives `pending`, the players who sat at that table but are still seated (so their result isn't recorded yet), and `unbalanced`, any chips the recorded results don't account for. Only a player from that game can read it. Databases from before this feature are upgraded in place; their older games have no hand log or table session.
- **One table per account**: the same account can't sit at two tables at once, e.g. from two tabs.
- **Not covered**: if the game service crashes outright (rather than being stopped), chips on the table at that moment are lost.
- **Guest mode**: without `ACCOUNTS_URL`, the game service falls back to the old behaviour (pick a name, free chips). The unit tests use it.

## Run it

```bash
docker compose up -d --build --wait
open http://localhost:8090        # host port: WEB_PORT (default 8090)
```

Tunables (env vars for compose): `WEB_PORT`, `BOT_DELAY_MS`, `NEXT_HAND_DELAY_MS`, `TURN_TIMEOUT_MS`, `RECONNECT_GRACE_MS`, `WELCOME_CHIPS`, and `ACCOUNTS_INTERNAL_KEY` (**set your own** anywhere other than your machine; the default is a placeholder).

Accounts live in the `holdem_accounts-data` volume and survive `docker compose down`; `docker compose down -v` wipes them.

Create an account (or log in), buy chips in the lobby if you need more, and pick a buy-in. Open the page in two browser windows with two accounts to play each other, or pick *Practice vs bots* and press **Add bot**. Then the host presses **Start game**. During a hand, **Hand rankings** opens a cheat sheet of all hand combinations.

- **Results**: after each hand a banner says whether you won or lost and by how much, and why the winner won (e.g. *"Three Queens beats Bob's Two Pair, Kings and Sevens"*, or a kicker comparison). The winning five cards glow, every revealed hand is labelled, and each seat shows its chip change.
- **Going broke**: a player who runs out of chips keeps their seat, sees the hand that busted them, and gets a dialog to **Rebuy** (paid from the bank; if the bank is short, the button buys a pack first) or go **Back to lobby**. A player left alone with chips sees *"You won the table!"*.
- **Session**: your login token is kept in `sessionStorage`, so refreshing the page logs you straight back in. **Log out** in the header leaves your table and ends the session on the server too.
- **Reconnecting**: refreshing the page (or a dropped connection) at a table doesn't cost you your seat. The server holds it for `RECONNECT_GRACE_MS` (60 s by default; `0` turns it off), and the other players see *Reconnecting…* on it. When you sign in again with the same account within that time, you land straight back at the table with your cards, your stack, host role and the turn clock as they were, plus a *Welcome back* message. While you're away the turn clock still runs, so your hand may be checked or folded for you. After the grace period you leave the table and your stack is paid back. Guest mode has no account to come back as, so guests leave at once.
- **Header**: the logo and *Hold'em Night* title go back home: the lobby, or the login screen when logged out. At a table they keep you there, because getting to the lobby means leaving the table.
- **Bank**: your balance is always in the header; the lobby has the chip shop and the buy-in field.
- **Table type**: the lobby's *Real chips* / *Practice vs bots* picker sets the type of the table you create. Each table in the list is labelled with its type; practice tables show *Practice · no chips at stake*, and only they have **Add bot**.
- **Profile**: click your initial or name in the header (from the lobby). It shows money stats from real-chip games (net result, chips won and lost, biggest hand win, best game, hands won), chips added to the bank and practice totals. Below that: a step chart of the bank balance after every change, a bar chart of each real-chip game's result (won in blue, lost in rust, a pair checked for colour-blind separation), the game history and the chips added (welcome bonus and packs). The charts use [TanStack Charts](https://tanstack.com/charts/latest) through its framework-free DOM host (`services/web/src/profile-charts.js`). The bundle loads only when the profile opens.
- **Game details**: click a table name in the profile's game history. The page shows the game's result, buy-in (with rebuys), cash-out and hands won; every player at that table and their totals; a chart of your running result hand by hand; and every hand with your cards, the board and who won with what.
- **Settle up** (real-chip games): enter what the chips are worth (e.g. *100 chips = 1.00 PLN*) and the page lists who pays whom. The rate is remembered in this browser. Hold'em Night never handles money: it only does the maths, and players pay each other however they like. Until everyone has left the table, the page names who is still seated and says there's nothing to settle yet.

### Web client

- **Styling**: Tailwind CSS v4 (`services/web/src/styles.css`) with a nature/wood theme: a dark olive room, light-oak panels with dark engraved text, and "carved block" buttons in small caps. Colours are CSS variables; wooden surfaces (`.panel`, `.seat`, `.modal`, `.result-banner`, `.wood`) redefine them for dark-on-wood, so components adapt automatically.
- **3D table**: three.js (`services/web/src/table3d.js`) draws the felt, rail and casino chips (white 1, red 5, green 25, black 100, purple 500, gold 1K). Bets drop in, slide into the pot at the end of each street, and slide to the winner at showdown. Seats, cards and labels stay as HTML pinned to 3D points, so they remain accessible and testable. The page renders a frame only when something changes, and honours `prefers-reduced-motion`.
- **Fallback**: without WebGL2, the client falls back to a CSS felt with CSS chip stacks.
- **Local build**: `cd services/web && npm ci && npm run build` writes `public/style.css`, `public/table3d.js` and `public/profile-charts.js`. All three are generated and git-ignored.

## Tests

### Unit (Node's built-in `node:test`, no extra test deps)

```bash
(cd services/evaluator && npm test)            # hand evaluator + REST API
(cd services/accounts && npm test)             # passwords, sessions, chip ledger, game records, profile stats, REST API (in-memory SQLite)
(cd services/game && npm ci && npm test)       # betting engine, side pots, lobby, table types, host start, turn clock, bank buy-ins/cash-outs, game stats, bots, WS server
docker build --target test services/game      # same tests inside the image build (also accounts, evaluator)
```

### End-to-end ([Maestro](https://maestro.dev) web flows)

Requires Maestro ≥ 2.x, Google Chrome, Docker and Node ≥ 22.

```bash
./e2e/run.sh                        # builds + starts the stack, runs every flow, tears down
./e2e/run.sh flows/03_fold.yaml     # a single flow
KEEP_UP=1 ./e2e/run.sh              # leave the stack running afterwards
HEADED=1 ./e2e/run.sh               # show the browser (flows run headless by default)
```

Flows sign in through `common/login.yaml`, which creates each test account on the first run, logs into it after that, and buys a 1,000 pack so repeated runs never empty the bank. `run.sh` also starts `e2e/remote-player.js`. It is a second, scripted player (it signs in through the accounts API) that connects over the public WebSocket endpoint and opens "Remote Table", then starts the game when someone joins, so the multiplayer flow plays against another real client. A JUnit report is written to `e2e/report.xml`.

| Flow | Covers |
|---|---|
| `01_lobby` | log in, create table, leave table |
| `02_play_vs_bots` | nothing is dealt until the host presses Start game, the timing rules are shown, full hand to showdown vs. two bots, next hand auto-deals |
| `03_fold` | turn countdown, blinds, fold, uncontested pot |
| `04_raise_validation` | server rejects an under-minimum raise; a legal raise is called |
| `05_multiplayer` | join another player's table from the lobby and play a hand over WebSockets, then open that game from the profile: players, settle up, hand log |
| `06_hand_rankings` | hand rankings cheat-sheet modal opens and closes mid-hand |
| `07_bust_or_win` | all-in until someone busts: rebuy dialog, or "You won the table!" |
| `08_session` | login survives a reload; a reload at a table goes straight back to the held seat; log out returns to the login screen |
| `09_bank` | register a new account, buy a pack, buy in (bank goes down), leave (stack paid back), wrong password rejected, balance kept after logging back in, buy-in above the bank refused |
| `10_profile` | a practice game against a bot leaves the bank untouched; the profile shows the stats, the game in the history, no real-chip games and the welcome bonus |

The bot flows (`02`, `03`, `04`, `06`, `07`, `10`) pick *Practice vs bots* before creating their table, and press **Start game** after adding their bots.
