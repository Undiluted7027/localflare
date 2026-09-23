# Localflare POC: a tiny Cloudflare you can take apart

Localflare is the working name for this project. This is a proposal, not an implemented project. The direction is an all-in-one, open-source local Cloudflare-like environment: bring an app, spin up a miniature internet around it, and see what survives.

**The experience to build**

One launch command starts a sample app, its Workers runtime and storage, HTTP rules, a programmable network, and a local dashboard. You can watch traffic move through the environment, change a rule while it runs, disconnect the origin, and inspect what happened.

The first proof is one compelling end-to-end experience. Someone should be able to open it, change something, and immediately understand the effect. Mininet and P4 make the network experiments possible; the app and its behavior are what the user sees first.

The intended first user is a developer who wants to understand how their Worker or app behaves when an edge rule, the network, or the origin misbehaves. “Tiny Cloudflare” describes the experience: a Cloudflare-shaped request path using the real Workers runtime, selected HTTP rules, and an emulated network. It is an unofficial local environment, with compatibility claims tied to demonstrated behavior.

The broader ambition is to bring your own app and save its entire local environment. The POC ships one sample and a documented way to connect another HTTP app. For network experiments, that app's traffic must pass through the connection being controlled. If an external origin bypasses those controls, make that limitation visible. The exact integration can be worked out during implementation; automatic setup for arbitrary projects comes later.

This proposal defines the experience and the outcomes to demonstrate. Process placement, event transport, privilege handling, and other architecture choices remain implementation decisions. Resolve them through working prototypes while preserving the agreed dashboard, runtime/storage, Mininet/P4, and replay capabilities.

**The first demo, from opening the dashboard to replaying a failure**

1. Launch the environment and open a dashboard showing `Visitors → Firewall → Edge Worker → Your app`, with the Worker's storage alongside it. Components show their actual readiness.
2. Start traffic from two emulated visitors. Requests appear on the map and in an event list. Select one to see its path, applied HTTP rules, response, and whether the Worker and origin were reached.
3. Show a rule-order mistake: visitor B requests `/public-admin`, which is rewritten to `/admin`. A block rule scoped to B checks the old path and misses. Inspect both paths, change the rule to match `/admin`, and watch B receive `403` before the Worker runs. Visitor A keeps working.
4. Switch B to the packet-drop preset. It now times out instead of receiving `403`. Show the client's attempt and supporting network observations, with no corresponding HTTP event observed during that attempt.
5. Disconnect the origin using a link control. The sample Worker returns its specified fallback. Restore the link and show the first successful response after recovery.
6. Save the rules, topology settings, seeded fixture references, and ordered experiment actions. Reset and rerun the experiment. Another developer can load the same bundle and check the same expected outcomes.

This is a real running environment. The map and event list must reflect observed traffic and configuration changes. A dropped packet gets a network observation, not an invented HTTP trace. Replay reruns the recorded actions against a reset environment; it does not promise identical timing or arbitrary application-state snapshots.

The walkthrough connects three recognizable outcomes: a rule returns an HTTP error, a packet drop prevents a response, and an unreachable origin triggers the app's fallback. Each gives the viewer something to change and a result they can explain.

**A small dashboard is part of the POC**

- A fixed topology map with two visitors, a packet filter, HTTP rules, a Worker, storage, and an origin. Show current health and highlight observed activity. D1/KV operations appear alongside the Worker when they occur, rather than as network hops on every request.
- A request/event inspector with enough detail to explain success, an HTTP block, a packet drop, and an origin failure. Label network observations separately from HTTP events.
- Controls to start/stop sample traffic, toggle the supplied rules, disconnect/reconnect the origin, and reset the environment. Applied configuration must be acknowledged by the backend before the UI shows it as active.
- Save/load and rerun controls for an experiment bundle, with a readable results report.

A topology editor, general-purpose rule builder, latency and packet-loss sliders, and cache visualization are follow-on features. The first dashboard uses supplied presets and an inspectable configuration file. Cache hits should only appear once a cache actually exists and has defined behavior.

**The technical experiments supporting the demo**

Use a deliberately small Workers app with a local D1 database, a KV namespace, and an ordinary HTTP origin. D1 records successful sample operations. KV holds a fixture such as a site message. The origin supplies a sample inventory response. This exercises real local bindings without expanding into every service before the integration works.

| Demonstration | What changes | What someone sees | Required evidence |
|---|---|---|---|
| A rewrite breaks a custom firewall rule | Rewrite `/public-admin` to `/admin`; initially write the block expression against the old path | The initial test unexpectedly reaches the app; correcting the expression blocks it | Original and rewritten path, matched rule, status, and whether the Worker ran |
| A packet firewall blocks one client | A P4 table entry drops traffic from client B to the edge's test port; client A remains permitted | B times out; A still reaches the app | Switch rule/counter or packet observation, plus no HTTP invocation for B |
| The origin disappears | Cut the emulated edge-to-origin link, then restore it | The Worker's bounded fetch fails, it returns the sample fallback response, then recovers | Link event, Worker fetch outcome, and response assertions |

The first case is grounded in documented Cloudflare behavior: URL rewrites run before WAF custom rules, which evaluate the rewritten URL. The other two are controlled network experiments, not claims to reproduce Cloudflare's network or error classification. [Cloudflare phase interactions](https://developers.cloudflare.com/waf/troubleshooting/phase-interactions/).

Make the distinction visible: a packet silently dropped before HTTP processing is different from an HTTP rule returning a 403. Do not invent an HTTP trace or request ID for traffic that never reached the HTTP layer.

**What the observations and replay must mean**

- Record a visitor's attempt even when it never reaches HTTP. Separate what the client experienced, what the network observed, and what the application did. A switch counter alone is insufficient to attribute a drop to a particular attempt when several requests are running; show uncertainty when the evidence cannot establish the connection.
- Keep the dashboard and its observations available while breaking the app's network path. Show actual changes and recovery, rather than inferring success from a control being clicked.
- Define what the disconnect control does and which failure it produced. An immediate connection error and a timeout are different observations; either can exercise the sample app's bounded fallback if described accurately.
- Record user actions and the configuration active at the time from the first interactive build. Replay should compare meaningful outcomes—blocking layer, response, Worker invocation, and fallback/recovery—without requiring identical timestamps or latency. Wait for relevant conditions with bounded deadlines.
- Save enough version and fixture information to explain differences between runs. Exercise reset/replay throughout the build, even though the complete export/import experience is a later checkpoint.

**What to reuse**

| Component | Proposed role | What we still have to supply |
|---|---|---|
| Miniflare/workerd | Execute the Worker and local D1/KV bindings | Startup, build/config integration, seeds, reset, and lifecycle management |
| Mininet | Create client, edge, and origin hosts and links | A reproducible topology and commands that alter the selected link |
| P4 on BMv2 | Run one small packet-filtering program in a software switch | Match/action tables, a way to load entries, and observations for the packet-drop scenario |
| wirefilter | Evaluate a deliberately supported subset of custom-rule expressions | HTTP field mapping, phase ordering, actions, and compatibility tests |
| A thin HTTP reverse proxy | Receive HTTP requests, apply supported rules, and dispatch to the Worker or origin | Integration and structured event output |

Cloudflare already supplies extensive local runtime and testing primitives. Reuse them rather than reimplementing bindings. Mininet supplies a network of Linux hosts and links; the P4 tutorials demonstrate Mininet integration and firewall exercises. BMv2 is a reference software switch, not a performance replica of Cloudflare. wirefilter supplies expression evaluation, not the full Ruleset Engine. [Cloudflare local development](https://developers.cloudflare.com/workers/local-development/), [test harness](https://developers.cloudflare.com/workers/testing/test-harness/), [Mininet](https://mininet.org/overview/), [P4 tutorials](https://github.com/p4lang/tutorials), [BMv2](https://github.com/p4lang/behavioral-model), [wirefilter](https://github.com/cloudflare/wirefilter).

Conceptually, Mininet contains this path:

```text
client A or B → P4 switch → HTTP rules → Worker → ordinary origin
                                          ↘ local D1 / KV
```

The proxy can also route an ordinary site directly to its origin. A Worker is not mandatory for every request. A redirect or block ends the relevant HTTP request's processing.

P4 gets a real but bounded job in this POC. IP/port filtering could also be implemented with Linux nftables; P4 is included to investigate the programmable-network direction you raised. Record whether it adds useful flexibility or only setup cost. Its inclusion is not a claim that P4 is required for a local Cloudflare environment.

**What we build ourselves**

1. A launcher that starts the components, waits for readiness, seeds the app, and tears down only its own resources.
2. One environment manifest referencing the existing Worker configuration, rule fixtures, and topology. Avoid requiring users to duplicate bindings in a second configuration format.
3. A small rule adapter for redirects, rewrites, and custom `block`/`log` actions. Start with method, path, and source IP fields plus the operators required by the demonstration. Unsupported fields, functions, or actions must fail configuration validation.
4. A scenario runner that issues requests from the correct emulated clients, applies changes, and checks results.
5. A local control/event API connecting the running components to the dashboard. Record rule changes and network actions alongside observed traffic, with clear distinctions between network and HTTP evidence.
6. The small dashboard described above. Terminal output and a saved report remain available for debugging and sharing, but the interactive experience is required for the finished POC.
7. Experiment export/import and replay: save supported configuration, fixture references, and actions; reset the environment; rerun and compare expected outcomes. Record the environment version so failures are reproducible.

Store supported HTTP rules in a documented Cloudflare-shaped JSON subset. Store P4 packet rules separately. Do not pretend a Cloudflare HTTP expression is automatically translatable to a P4 table.

**Packaging and practical limits**

For the complete POC, target a reproducible Linux VM/appliance. Mininet depends on Linux network facilities; macOS users run the lab in a VM. Verify the chosen toolchain on the intended CPU architecture before promising an Apple Silicon download. Isolate elevated networking operations inside the lab VM.

The experience to aim for is “one launch command after documented setup.” A later package can improve installation. After dependencies are present, the supplied demonstrations should work without a Cloudflare account or external service calls. Check startup and the full demo with internet access disabled; investigate any runtime defaults that require external data rather than assuming local execution is automatically offline.

Validate the toolchain early on the intended development machine. Keep the local controls restricted to the lab's supported actions, and bound the sample traffic so accidental overload does not obscure the experiment. The mechanisms for these requirements can be chosen during implementation.

Use a local test hostname and HTTP for the first lab. HTTPS termination and browser trust can be added explicitly afterward; P4 should not be presented as decrypting or inspecting encrypted URL paths. All acceptance-test traffic must originate in the emulated clients so a convenience port-forward cannot accidentally bypass the packet firewall.

Full management API emulation, Terraform apply compatibility, Cloudflare-managed WAF rules, bot detection, CDN cache fidelity, global rate limiting, and production hosting are outside this particular proof. Existing services can be added later without changing the core experiment. This boundary is about what the POC can demonstrate honestly, not the project's ultimate ceiling.

**Build in checkpoints, with a useful result at each one**

| Checkpoint | Engineering result | Material worth sharing |
|---|---|---|
| 1. The miniature environment runs | Validate the toolchain; sample Worker, D1/KV fixtures, and origin start/reset together; a basic map shows readiness | The first app running inside its own local edge environment, with a sketch of the request path |
| 2. Requests become visible | Real events populate the map and inspector; rule changes are recorded; the rewrite mistake and fix are interactive | A short clip showing why a rule missed, then changing it and watching one visitor get blocked |
| 3. Networking becomes interactive | Both clients traverse BMv2; a packet-drop preset produces distinct evidence from the HTTP block | Why one visitor gets a 403 while another times out |
| 4. You can break and restore the app's connection | Dashboard controls interrupt the origin link and show fallback/recovery | What happened when you disconnected the origin, including anything unexpected |
| 5. Someone else can replay it | Export/load/reset/rerun work in a clean supported environment | A complete demo and an experiment others can try or modify |

Treat these as checkpoints, not a promised release calendar. The complete interactive demo is the POC. Each checkpoint should also leave something real to show while it is being built. The rewrite/rule-order experiment is part of the main walkthrough as well as a repeatable engineering check.

**What counts as finished**

- A fresh supported Linux environment can start and stop the entire lab from the instructions.
- Once dependencies are installed, startup and the supplied demo work with internet access disabled.
- Its local dashboard shows actual readiness and observed traffic through the fixed topology.
- A user can select a request and understand its outcome; network-only failures are represented without fabricating HTTP events.
- Rule toggles and link controls change the running environment, with backend confirmation and visible outcomes.
- Normal requests reach the Worker and exercise D1/KV.
- Redirect tests verify the destination and that the Worker did not run for that original request.
- The rewrite/custom-block case has a failing fixture and a corrected fixture with explicit expected outcomes.
- The blocked-client scenario records the client attempt and network-level evidence, states the observation window for absent HTTP events, and distinguishes direct evidence from inference; the permitted client still succeeds.
- Origin interruption produces an explained failure and the application's specified fallback; restoration produces an observed successful response. The dashboard remains available throughout.
- Reset restores the seeded app, rule tables, and topology. Repeating scenarios does not depend on hidden state from a previous run.
- An exported experiment can be loaded after a reset and rerun with the same configuration, action sequence, and expected outcomes. The bundle identifies its required environment version and fixtures.
- Unsupported rule syntax produces an error rather than silently allowing traffic.
- Another developer can complete the dashboard walkthrough and reproduce a saved experiment without the author narrating the setup.

For Cloudflare-specific claims, maintain a tiny conformance table: behavior, source, local fixture, and whether it was compared with live Cloudflare. Optional live comparisons can use a disposable test zone; local users should not need an account. “Documented model” and “live comparison passed for these cases” are different labels. Passing selected fixtures does not certify full compatibility.

**The public-building approach**

Use the builder-focused strategy supplied by the user: let people see useful parts of the work while it happens. Each post should offer something on its own and give interested developers a reason to follow the next experiment. The project can produce a body of work and technical conversations without becoming a company or a launch campaign.

The closest fit is learning in public. Swyx recommends publishing useful explanations, questions, and contributions as you learn. Simon Willison recommends short notes about things learned and descriptions/screenshots of completed projects. Both fit a builder who wants better understanding, conversations, and a visible body of work. [Learn In Public](https://swyx.io/learn-in-public), [What to blog about](https://simonwillison.net/2022/Nov/6/what-to-blog-about/).

Use one repeatable note:

> What I tried → what actually happened → the evidence → what I changed or still don't understand.

Keep these notes in the repository. They become concise X posts, fuller Reddit explanations, documentation, and reproducible examples. The project does not need a separate content production operation.

Use the full rhythm when there is something worth discussing:

1. **Show the thing:** a real clip, diagram, snippet, before/after, or runnable example.
2. **Explain one decision:** what you tried, what happened, and why you chose the next step.
3. **Invite specific input:** ask about an unresolved tradeoff that you actually want help with.
4. **Return with the result:** test useful suggestions, explain the outcome, and credit the people who helped.

For example, once the packet demo exists, share its observations and ask whether they establish where the request stopped. If someone identifies a gap, try their suggestion and show whether it made the explanation more reliable. Do not invent a bug or perform uncertainty just to manufacture a post.

The recurring story is “I'm building a tiny Cloudflare on my laptop, and here's what I got working or broke today.” Show the working environment, the awkward intermediate versions, and the discoveries. Use the interactive demo to make the work understandable; traces and fixtures supply the detail when someone wants to go deeper. Avoid founder-style launch countdowns or treating every update as a pitch.

**How this fits your X account**

Your supplied September 22 review found 2,223 views and 49 bookmarks on a concrete tools/use-cases reply, and 737 views for a joke as a reply versus three for the same wording standalone. These are selected observations, not an algorithm experiment. They support beginning with useful contributions to existing conversations. They do not establish demand for this project.

- Look for current discussions about Workers testing, Cloudflare rules, reproducible environments, P4, and networking failures where you can answer something specific.
- Make the answer useful without requiring a repo click. Link a fixture or explanation when it directly helps.
- Publish a standalone post when the build gives you something visible: the first request crossing the map, a rule changing an outcome, a broken connection, a debugging discovery, or an experiment someone can replay. Include traces and fixtures where they help explain it.
- Keep casual humor and unrelated developer conversation. This project is one part of your account alongside co-op life, tools, and other projects.
- Let local cloud emulation and developer experience become a recognizable thread in your work without turning the whole account into a networking-specialist profile.
- Aim for two or three concrete observations during an active build week, including useful replies; some can become standalone posts when there is enough to show. Skip filler in quiet weeks. This is a flexible rhythm, not a reach guarantee.
- Return to relevant earlier conversations when you have a working result or an answer. In particular, the earlier reproducible-security-environments discussion can become a place to share what you learned once the lab exists.

Draft for the exploration stage, paired with an actual topology sketch or early artifact and after checking recent posts for duplication:

> trying to build a tiny Cloudflare that runs on my laptop. bring an app, put a firewall and Worker in front of it, then break the network and see what happens. starting with one app and two visitors.

Example only if this mistake actually happens during the build:

> gave my tiny Cloudflare two visitors and accidentally blocked both. here's the rule I got wrong and what fixed it.

Draft only after the interactive origin-failure demo works:

> added a button that disconnects the origin. the app falls back, reconnects, and recovers. saved the whole experiment so someone else can run it too. [clip + reproducible example]

Draft only after the HTTP-rule experiment works:

> this request starts as /public-admin, gets rewritten to /admin, then misses my firewall rule because I matched the old path. tiny local repro + the trace below. rule order is doing a lot of work here.

Draft only after the packet experiment works:

> one client gets a 403. the other times out. both are “blocked,” but by completely different layers. finally got the P4 counter and HTTP trace telling the same story.

These are starting drafts, not posted messages or claims that the work is already done.

**How to use Reddit**

Reddit posts should stand alone as technical explanations. A good post includes the question, setup, observed behavior, what is incomplete, and one specific thing you want help checking.

Candidate placements:

- r/CloudFlare: the rewrite/rule-order experiment, with clear disclosure that this is your unofficial local prototype. Check the current rules before posting; the public rules page did not expose its contents in this research.
- r/devops: use the community's current weekly self-promotion thread for a project introduction; recent threads explicitly invite projects and repos. Focus on reproducible failure testing. [Example community thread](https://www.reddit.com/r/devops/comments/1w9k9gw/weekly_self_promotion_thread/).
- r/SideProject: a later working demonstration and what you learned packaging it, subject to its current rules.

Example project-demo title after the result exists: “I'm building a tiny local Cloudflare: watch requests, change firewall rules, and disconnect the origin.”

For a deeper technical discussion: “I put a Worker behind a local P4 switch: why a dropped packet and an HTTP 403 need different debugging.”

A useful question is “Here is the topology and packet observation; is this actually exercising the failure I think it is?” That gives knowledgeable readers something concrete to inspect.

When feedback changes the experiment, return to the discussion with the result and credit. A follow-up should explain what changed even for someone who did not read the original post.

Tailor each contribution to its community. Reddit's guidance emphasizes authentic participation and prohibits repetitive mass exposure. There is no universal posting ratio to use as permission. [Reddit spam guidance](https://support.reddithelp.com/hc/en-us/articles/360043504051-Spam).

**Judge the project and the public work separately**

For the experience: can someone open the dashboard, follow a request, change a rule, break a connection, and understand what happened?

For engineering: can someone replay the saved experiment, do the displayed results agree with actual observations, and does the combined environment save setup or debugging effort?

For learning and community: did someone correct an assumption, contribute a fixture, explain a networking detail, or try the lab? These are useful even if the project never becomes a business.

For reach: compare your own similar posts over time—replies with replies, demos with demos—and note relevant conversations and visible saves. Low impressions alone are not evidence against the project. Stars and views are supporting observations, not the reason to build it.

The first public milestone worth aiming for is someone running the demo, changing something themselves, and sharing an experiment of their own. That connects the project's ambition to a small experience we can actually finish.
