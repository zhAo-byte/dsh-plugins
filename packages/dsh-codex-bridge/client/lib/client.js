window.__ModuleLoader__.load({
	id: "dsh-codex-bridge-client",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		//#region dsh-codex-bridge-client: constants
		/**
		 * The settings namespace the host row (`codex-panel`) publishes. The card
		 * only reads it; nothing here ever writes a settings document.
		 */
		const PANEL_NAMESPACE = "codex-bridge";
		/** Browser services this card consumes: the slot ledger and the namespace scope. */
		const inject = ["slots", "settingsScope"];
		//#endregion

		//#region dsh-codex-bridge-client: styles
		/*
		 * Hand-authored bundle, no bundler: styles ride one injected <style> tag
		 * whose body lives in the factory closure. Only shell-guaranteed design
		 * tokens are used — the full theme alias surface is not part of the
		 * baseline module table, so anything richer could silently resolve to
		 * nothing in a future shell build.
		 */
		const CSS = [
			".cxb-section { display: flex; flex-direction: column; gap: 10px; }",
			".cxb-section-title { margin: 0; font-size: 15px; font-weight: 600; }",
			".cxb-section-lede { margin: 0 0 4px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-text-secondary, #9aa3b2); }",
			".cxb-card{box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;border:0;border-radius:14px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));box-shadow:0 0 0 .5px var(--dsw-alias-border-l2,rgba(127,127,127,.3))}",
			".cxb-summary{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;list-style:none}",
			".cxb-summary::-webkit-details-marker{display:none}",
			".cxb-summary:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}",
			".cxb-summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}",
			".cxb-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .14s ease-in-out}",
			"details[open]>.cxb-summary .cxb-chevron{transform:rotate(180deg)}",
			".cxb-headText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
			".cxb-name{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}",
			".cxb-description{color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:18px}",
			".cxb-tally{display:flex;align-items:center;gap:6px;flex:none}",
			".cxb-tallyCount{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}",
			".cxb-body{display:flex;flex-direction:column;gap:12px;padding:4px 14px 14px;background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.04))}",
			".cxb-group{display:flex;flex-direction:column;gap:6px}",
			".cxb-groupTitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}",
			".cxb-list{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}",
			".cxb-row{display:flex;align-items:baseline;gap:8px;min-width:0}",
			".cxb-rowLabel{flex:none;color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:500;line-height:18px}",
			".cxb-rowLabel--code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px}",
			".cxb-rowDetail{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}",
			".cxb-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}",
			".cxb-dot[data-tone='off']{background:var(--dsw-alias-label-tertiary);opacity:.55}",
			".cxb-dot[data-tone='ok']{background:var(--dsw-alias-state-success-primary,#2f9e63)}",
			".cxb-dot[data-tone='warn']{background:var(--dsw-alias-state-warn-primary,#c98a1b)}",
			".cxb-dot[data-tone='bad']{background:var(--dsw-alias-state-error-primary,#d8503f)}",
			".cxb-bucket{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px}",
			".cxb-meta{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px;overflow-wrap:anywhere}",
			".cxb-loading{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:18px}"
		].join("");
		/** Idempotent across HMR reloads: one style tag per bundle id. */
		function installStyles() {
			if (typeof document === "undefined") return;
			const tagId = "dsh-codex-bridge-client/codex-panel.css";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-codex-bridge-client";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region dsh-codex-bridge-client: view model
		/** Snapshot shape standing in when no scope is injected; keeps reads total. */
		const EMPTY_SNAPSHOT = { status: "unavailable", value: undefined };
		/** @returns the same empty snapshot every time, so state identity stays stable. */
		function emptySnapshot() {
			return EMPTY_SNAPSHOT;
		}

		/**
		 * Map one auth state to a state tone. The dots are the whole legend: `ok`
		 * is the only state that means "nothing to do", everything else is read as
		 * an action item in the Codex-side tool.
		 */
		function authTone(state) {
			if (state === "ok") return "ok";
			if (state === "expired" || state === "apikey") return "warn";
			return "bad";
		}

		/**
		 * Classify one skip reason into the severity the reader should feel.
		 *
		 * `enabled = false in Codex config` is **not** a defect: it is Codex's own
		 * opt-out, honored exactly as Codex intends ("你在 Codex 里关掉的，这里不会偷偷
		 * 打开"). Painting those red drowns the entries that do deserve attention —
		 * malformed frontmatter, an unusable name — in a sea of alarms.
		 *
		 * The reason line is the host's text, not a wire enum: `status.js` composes
		 * it from the provider's rejection and the MCP bridge's skip record. Matching
		 * the phrase is therefore the contract, and it is the only signal the browser
		 * has without extending the namespace with a structured field.
		 *
		 * @param reason - `"<path|name>: <reason>"` line from the host row.
		 * @returns `"off"` for a deliberate Codex-side disable, `"bad"` otherwise.
		 */
		function severityOf(reason) {
			return reason.includes("enabled = false") ? "off" : "bad";
		}

		/**
		 * Partition skip lines into the two buckets the card shows, keeping host order.
		 * @param entries - skip lines from the host row.
		 * @returns the lines bucketed by severity.
		 */
		function partitionSkips(entries) {
			const off = [];
			const bad = [];
			for (const entry of entries) (severityOf(entry) === "off" ? off : bad).push(entry);
			return { off, bad };
		}

		/**
		 * Recount the namespace's scalars against its reason lines.
		 *
		 * The namespace carries both, and they can disagree: a freshly registered
		 * namespace resolves its schema defaults (`0`) until the host's first write
		 * lands, and the first write is what fills the lines. The scalars are the
		 * authority once the lines exist, because they come from the same collection
		 * pass; the subtraction only covers the window where the lines have not
		 * arrived yet.
		 *
		 * @param state - the `codex-bridge` namespace section.
		 * @returns the numbers the card renders.
		 */
		function rollup(state) {
			const skills = partitionSkips(state.skillsSkippedReasons ?? []);
			const mcp = partitionSkips(state.mcpSkippedReasons ?? []);
			const haveLines = skills.off.length + skills.bad.length > 0;
			return {
				skills,
				mcp,
				skillsUsable: haveLines ? (state.skillsUsable ?? 0) : (state.skillsUsable ?? 0) - (state.skillsSkipped ?? 0),
				skillsOff: skills.off.length,
				skillsBad: skills.bad.length,
				mcpServers: state.mcpServers ?? 0,
				mcpOff: mcp.off.length,
				mcpBad: mcp.bad.length
			}
		}

		/** One status dot. */
		function StateDot(props) {
			return react.createElement("span", { className: "cxb-dot", "data-tone": props.tone, "aria-hidden": "true" });
		}

		/** One label/detail row; `code` renders the label as a path or server name. */
		function Row(props) {
			return react.createElement("li", { className: "cxb-row" }, [
				props.tone === undefined ? null : react.createElement(StateDot, { key: "dot", tone: props.tone }),
				react.createElement("span", {
					key: "label",
					className: props.code === true ? "cxb-rowLabel cxb-rowLabel--code" : "cxb-rowLabel"
				}, props.label),
				props.detail === undefined ? null : react.createElement("span", { key: "detail", className: "cxb-rowDetail" }, props.detail)
			]);
		}

		/** A titled group of rows; skipped-entry groups render their count in the title. */
		function Group(props) {
			return react.createElement("div", { className: "cxb-group" }, [
				react.createElement("p", { key: "title", className: "cxb-groupTitle" }, props.title),
				react.createElement("ul", { key: "list", className: "cxb-list" }, props.children)
			]);
		}

		/** A one-line note, used for the empty and loading states. */
		function Note(props) {
			return react.createElement("p", { className: "cxb-loading" }, props.children);
		}

		/**
		 * Format the host's collection timestamp in the reader's locale.
		 * @param value - ISO timestamp from the host row.
		 * @returns display text, or the raw value when it is not a date.
		 */
		function formatMoment(value) {
			const at = new Date(value);
			if (Number.isNaN(at.getTime())) return String(value);
			return at.toLocaleString();
		}

		/**
		 * Rows for the skills or servers the bridge left out — one row per entry,
		 * with the reason the host logged.
		 * @param entries - `"<path|name>: <reason>"` lines from the host row.
		 * @param tone - `"off"` (a deliberate disable) or `"bad"` (a source defect).
		 * @param keyPrefix - React key prefix keeping the groups' keys distinct.
		 * @returns one row per entry.
		 */
		function skippedRows(entries, tone, keyPrefix) {
			return entries.map((entry, index) => react.createElement(Row, {
				key: keyPrefix + index,
				tone,
				label: entry,
				code: true
			}));
		}

		/**
		 * The rows of one skills-or-MCP group.
		 *
		 * The two bucket headers are what keep the card honest: `N rejected` used
		 * to read as one alarm while 15 of the 21 lines merely restated the user's
		 * own `enabled = false`. A deliberate disable gets a neutral header and a
		 * dimmed dot; only real source defects get the error treatment.
		 * @param buckets - `{ off, bad }` skip lines.
		 * @param prefix - React key prefix for this group.
		 * @returns the group's list items.
		 */
		function skipRows(buckets, prefix) {
			const rows = [];
			if (buckets.off.length > 0) {
				rows.push(react.createElement("li", { key: `${prefix}offTitle`, className: "cxb-bucket" },
					`${buckets.off.length} disabled in the Codex config — not a problem`));
				rows.push(...skippedRows(buckets.off, "off", `${prefix}off-`));
			}
			if (buckets.bad.length > 0) {
				rows.push(react.createElement("li", { key: `${prefix}badTitle`, className: "cxb-bucket" },
					`${buckets.bad.length} the source itself has a problem`));
				rows.push(...skippedRows(buckets.bad, "bad", `${prefix}bad-`));
			}
			return rows;
		}
		//#endregion

		//#region dsh-codex-bridge-client: CodexPanelCard
		/**
		 * The Codex panel card: one disclosure in the Plugins settings section,
		 * read-only by construction — every value comes from the host-owned
		 * `codex-bridge` settings namespace, and nothing here writes it back.
		 *
		 * A card registered into `settings.plugin.item` is only ever dispatched
		 * once the host serves its key, so the namespace is known to exist; the
		 * value still crosses the wire, which is what the loading state covers.
		 */
		function CodexPanelCard(props) {
			// The scope arrives as injected props. The reads are defaulted rather
			// than assumed: a shell whose slot contract drops them should degrade
			// to a static (but truthful) card, never take the settings pane down.
			const readSnapshot = typeof props.readSnapshot === "function" ? props.readSnapshot : emptySnapshot;
			const subscribe = typeof props.subscribe === "function" ? props.subscribe : () => () => {};
			const [snapshot, setSnapshot] = react.useState(readSnapshot);
			react.useEffect(() => subscribe(() => {
				setSnapshot(readSnapshot());
			}), []);

			const state = snapshot.value;
			const counts = state === undefined ? undefined : rollup(state);
			const summary = counts === undefined
				? "reading host state…"
				: `skills ${counts.skillsUsable}${counts.skillsOff > 0 ? ` · ${counts.skillsOff} off` : ""}` +
					`${counts.skillsBad > 0 ? ` · ${counts.skillsBad} bad` : ""} · mcp ${counts.mcpServers}`;

			// A group title carries its counts, so the body only speaks when there is
			// something to act on: the clean state gets one green row, a dirty state
			// gets its entries, separated into deliberate disables and real defects.
			const body = state === undefined
				? react.createElement(Note, null, "Reading Codex state from the host…")
				: react.createElement(react.Fragment, null, [
					react.createElement(Group, { key: "auth", title: "Login" },
						react.createElement(Row, {
							tone: authTone(state.authState),
							label: state.authMode === "" ? "codex login" : state.authMode,
							detail: state.authDetail
						})),
					react.createElement(Group, {
						key: "skills",
						title: `Skills · ${counts.skillsUsable} usable` +
							`${counts.skillsOff > 0 ? `, ${counts.skillsOff} disabled by config` : ""}` +
							`${counts.skillsBad > 0 ? `, ${counts.skillsBad} with source problems` : ""}`
					},
						state.skillsSkipped === 0
							? react.createElement(Row, { tone: "ok", label: "every discovered skill is registered" })
							: skipRows(counts.skills, "skill-")),
					react.createElement(Group, {
						key: "mcp",
						title: `MCP · ${counts.mcpServers} loaded` +
							`${counts.mcpOff > 0 ? `, ${counts.mcpOff} disabled by config` : ""}` +
							`${counts.mcpBad > 0 ? `, ${counts.mcpBad} with problems` : ""}`
					},
						state.mcpSkipped === 0
							? react.createElement(Row, {
								tone: state.mcpServers === 0 ? "warn" : "ok",
								label: state.mcpServers === 0 ? "no MCP server loaded" : `${state.mcpServers} server(s) reachable`,
								detail: state.mcpServers === 0 ? "check excludeServers and the Codex config" : undefined
							})
							: skipRows(counts.mcp, "mcp-")),
					react.createElement("p", { key: "meta", className: "cxb-meta" },
						`read ${formatMoment(state.generatedAt)} · Codex files are read-only from here`)
				]);

			return react.createElement("li", { className: "cxb-card" },
				react.createElement("details", null, [
					react.createElement("summary", { key: "summary", className: "cxb-summary" }, [
						react.createElement("span", { key: "text", className: "cxb-headText" }, [
							react.createElement("span", { key: "name", className: "cxb-name" }, "Codex bridge"),
							react.createElement("span", { key: "description", className: "cxb-description" },
								"Codex skills, MCP servers, and login state as DSH sees them")
						]),
						react.createElement("span", { key: "tally", className: "cxb-tally" }, [
							// The dot is the worst true thing in the card: an auth problem
							// or a source defect, but never a deliberate disable.
							react.createElement(StateDot, {
								key: "dot",
								tone: state === undefined
									? "unknown"
									: authTone(state.authState) === "bad" || counts.skillsBad > 0 || counts.mcpBad > 0
										? "warn"
										: authTone(state.authState)
							}),
							react.createElement("span", { key: "count", className: "cxb-tallyCount" }, summary)
						]),
						react.createElement(Chevron, { key: "chevron" })
					]),
					react.createElement("div", { key: "body", className: "cxb-body" }, body)
				]));
		}

		/** The disclosure chevron; a plain glyph keeps the card free of non-baseline modules. */
		function Chevron() {
			return react.createElement("span", { className: "cxb-chevron", "aria-hidden": "true" }, "\u25be");
		}
		//#endregion

		//#region dsh-codex-bridge-client: apply
		/** The settings section's nav key and order. */
		const SECTION_ID = "codex-bridge";
		/** Right after the shipped sections (general 0, models 10, plugins 15, agent-presets 20). */
		const SECTION_ORDER = 26;

		/**
		 * The card's injected face over the panel namespace.
		 *
		 * One factory, used by both mount points, so the tab and the Plugins-tab card
		 * can never drift into reading different state.
		 *
		 * @param scope - the bound settings scope.
		 * @returns the injected props.
		 */
		function scopeProps(scope) {
			return {
				readSnapshot: () => scope.getSnapshot(),
				subscribe: (listener) => scope.subscribe(listener)
			};
		}

		/**
		 * Mount the panel.
		 *
		 * Registered twice, on purpose:
		 *
		 * - `settings.section` gives it a **top-level settings page of its own**. The
		 *   settings shell is data-driven — the slot contract states that a feature
		 *   owns its own settings pages and that adding a setting never means editing
		 *   the shell — so this is the supported way to get a page rather than a copy
		 *   of one.
		 * - `settings.plugin.item` keeps the Plugins → Plugin configuration card, so
		 *   that tab stays an index of configurable plugins.
		 *
		 * The page renders the same component: this bridge has no settings of its own
		 * to edit, it reports what it found, and splitting the read-only panel into a
		 * second component would only duplicate it.
		 *
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			installStyles();
			const scope = ctx.settingsScope.bind({ namespace: PANEL_NAMESPACE });
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: PANEL_NAMESPACE,
				inject: () => scopeProps(scope)
			}, CodexPanelCard));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: SECTION_ID,
				order: SECTION_ORDER,
				// A function, matching every shipped registrant: the shell resolves the
				// label through `resolveSlotLabel` and re-reads it on locale change.
				// Text lives here because this plugin ships no translations.
				label: () => "Codex 桥",
				inject: () => scopeProps(scope)
			}, CodexPanelSection));
		}

		/**
		 * The section page: a title, a line of orientation, and the panel.
		 *
		 * `props.close` is supplied by the shell and deliberately unused — nothing here
		 * leaves settings. It is named so the reason is visible.
		 *
		 * @param props - the injected props plus the shell's `close`.
		 * @returns the React element.
		 */
		function CodexPanelSection(props) {
			return react.createElement("div", { className: "cxb-section" }, [
				react.createElement("h2", { key: "title", className: "cxb-section-title" }, "Codex 桥"),
				react.createElement("p", { key: "lede", className: "cxb-section-lede" },
					"这个桥把 Codex 的 skill 与 MCP server 接进 DSH。下面是它读到的东西，对 Codex 侧只读。"),
				react.createElement(CodexPanelCard, { key: "panel", ...props })
			]);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.PANEL_NAMESPACE = PANEL_NAMESPACE;
		exports.SECTION_ID = SECTION_ID;
		exports.CodexPanelSection = CodexPanelSection;
		return module.exports;
	}
});
