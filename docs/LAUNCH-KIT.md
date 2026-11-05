# Launch kit

Copy pieces for announcing the router. Written to be pasted as-is. Adjust the
first line of the Discord post to your own voice before posting.

## npm — published

`@qadanm/opencode-smart-router@0.4.0` is live on the registry:
https://registry.npmjs.org/@qadanm/opencode-smart-router

The npm tarball ships the routing core (one 634 KB ESM file, no runtime
dependencies). Future releases publish with the same one-liner:

## Discord (show-and-tell)

> Title: Smart Router: self-healing model routing for OpenCode
>
> I keep subscriptions across three providers, so I wrote a router for OpenCode
> that prices every prompt against what the plans actually allow: 5h/weekly/monthly
> windows, credit pools, and an intelligence floor. It picks the cheapest model
> that qualifies, pays the switch-off penalty against a warm prompt cache, and
> explains every choice in a desktop panel.
>
> What came out of real use: rebuilt sessions put mid-session notices into the
> prompt as system roles, and on any Anthropic-protocol model that killed the
> whole turn with `Expected 'user' | 'assistant' at messages.23.role`. So 0.4.0
> is self-healing. The router folds those notices into user messages before the
> request leaves, refuses the host retry on a deterministic 400, and if a
> provider still rejects the turn it re-routes to the next best model and
> continues with a one-line notice.
>
> Install:
> - one line in opencode.json: `"plugin": ["@qadanm/opencode-smart-router"]`
> - or the installer for the desktop panel and /router-report:
>   `curl -fsSL https://raw.githubusercontent.com/qadanm/opencode-smart-router/main/install | bash`
>
> MIT, 759 tests. Repo: https://github.com/qadanm/opencode-smart-router

## Hacker News (Show HN)

Title: `Show HN: Smart Router: subscription-aware model routing for OpenCode`

> Smart Router is a plugin for OpenCode (an open-source coding agent) that does
> model selection on your own terms. Most routers ask what a token costs. This
> one asks what your subscription allows: it reads the nested windows each
> provider bills against, the separate credit pools, and the context size of the
> prompt, then picks the cheapest eligible model above an intelligence floor.
> Switching has a real cost, because a cold prompt cache is re-sent as fresh
> input, so the router only moves when the saving clears a margin. Every decision
> shows up in a desktop panel with the full candidate list and the reasons.
>
> The interesting engineering problem this month was not routing. It was that
> rebuilt sessions were killing turns on Anthropic-protocol providers with a
> deterministic 400: mid-session notices entered the prompt array as system
> roles, and Anthropic only accepts user and assistant. Upstream treats it
> differently per protocol, so the router handles it: mid-conversation system
> entries fold into user messages before the request leaves, the retry hook
> refuses the doomed attempt, and the turn continues on the next best eligible
> model with one notice in the session. One failover per prompt, capped, so it
> can never loop.
>
> Install without the panel by adding one line to opencode.json; with it, by one
> bash command. 759 tests, MIT. Happy to answer questions about the
> eligibility/allowance modeling.
>
> https://github.com/qadanm/opencode-smart-router

## X/Twitter thread

The demo film is `assets/smart-router-demo.gif` (4.3 MB); `assets/smart-router-demo.mp4`
for uploads that prefer video. Panels remain as stills.

1/ Every other model router asks what a token costs. Mine asks what your
subscription allows. Smart Router for OpenCode routes on your actual allowance:
nested windows, credit pools, and floor-gated eligibility.
[attach demo GIF]

2/ The part I'm most happy with: it explains itself. Every prompt shows its last
decision in a panel next to your session: the chosen model, what it costs, why it
beat the other candidates, and what got blocked, with the reason.
[attach router-decision.png]

3/ Real bug, caught on a live session: rebuilt sessions carry mid-session
notices into the prompt as system roles. Anthropic only accepts user and
assistant. Every turn on a Claude model died with the same 400 and burned
retries doing it.

4/ So 0.4.0 is self-healing. The router repairs the prompt in flight (folds
those notices into user messages), refuses to retry a request the provider
rejected before generating anything, and if a turn still gets rejected it moves
to the next best eligible model and continues, one notice in your session. Once
per prompt. It cannot loop.

5/ Install in one line, or with the panel and onboarding:
 `"plugin": ["@qadanm/opencode-smart-router"]`
https://github.com/qadanm/opencode-smart-router

## opencode.cafe submission

Submit via the site's own form with: repo link, npm name
`@qadanm/opencode-smart-router`, and one line: subscription-aware model
routing for OpenCode with a self-healing turn-failover.
