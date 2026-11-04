window.__ModuleLoader__.load({
	id: "dsh-paper-reader",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		var NAME = "paper-reader";

		/** 左栏图标：一本打开的书 */
		function PanelIcon(props) {
			var size = (props && props.size) || 16;
			return h("svg", {
				width: size, height: size, viewBox: "0 0 24 24", fill: "none",
				stroke: "currentColor", strokeWidth: 1.7,
				strokeLinecap: "round", strokeLinejoin: "round",
				"aria-hidden": "true"
			},
				h("path", { d: "M12 6.5c-1.7-1.2-3.8-1.8-6-1.8v12.6c2.2 0 4.3.6 6 1.8 1.7-1.2 3.8-1.8 6-1.8V4.7c-2.2 0-4.3.6-6 1.8z" }),
				h("path", { d: "M12 6.5v12.6" })
			);
		}

		/** 主区：系统标题栏（品牌/搜索/上传/日志/主题/分区）+ 阅读器 iframe */
		function ReaderPanel() {
			var frameRef = React.useRef(null);
			var lostState = React.useState(false);
			var lost = lostState[0], setLost = lostState[1];
			var themeState = React.useState("light");
			var dark = themeState[0] === true, setDark = themeState[1];
			var colState = React.useState({ list: [], active: "all" });
			var cols = colState[0], setCols = colState[1];
			var jobState = React.useState(null);
			var jobStatus = jobState[0], setJobStatus = jobState[1];
			var padState = React.useState(12);
			var leftPad = padState[0], setLeftPad = padState[1];
			var darwin = /Mac/i.test(navigator.platform || "") || /Macintosh/i.test(navigator.userAgent || "");
			try { if (document.documentElement.getAttribute("data-platform") === "darwin") darwin = true; } catch (e) {}
			var appBase = location.origin + "/paper-reader/app";
			var appUrl = appBase + "?embed=" + (darwin ? "darwin" : "web") + "&chrome=1";

			var bg = dark ? "#14161a" : "#fffdf8";
			var fg = dark ? "#e7e3da" : "#232323";
			var line = dark ? "#2d3139" : "#e4e0d6";
			var muted = dark ? "#b9b3a6" : "#555";

			var send = function (msg) {
				try {
					var f = frameRef.current;
					if (f && f.contentWindow) f.contentWindow.postMessage(Object.assign({ source: "pr-host" }, msg), "*");
				} catch (e) {}
			};
			var syncStrip = function () {
				try {
					var d = frameRef.current && frameRef.current.contentDocument;
					if (!d) return;
					// 主题由阅读器回报，这里只兜底
					var t = d.documentElement.getAttribute("data-theme");
					if (t) setDark(t === "dark");
				} catch (e) {}
			};
			var onLoad = function () {
				var f = frameRef.current;
				if (!f) return;
				var inside = false;
				try { inside = f.contentWindow.location.href.indexOf(appBase) === 0; } catch (e) { inside = false; }
				setLost(!inside);
				syncStrip();
				send({ type: "hello" });
			};

			// macOS：收起侧栏时给红绿灯让位（展开时面板本来就右移）
			React.useEffect(function () {
				var syncPad = function () {
					if (!darwin) { setLeftPad(12); return; }
					var col = document.querySelector("[class*='_sidebarCol']");
					var w = col ? col.getBoundingClientRect().width : 0;
					// 红绿灯右缘约 86；收起侧栏时「打开侧栏 / 新建会话」按钮浮在内容上方，
					// 直接量它们的实际位置，避免类名变化导致失效。
					var right = 86;
					var seat = document.querySelector("[class*='_leadingSeat']");
					if (seat) right = Math.max(right, seat.getBoundingClientRect().right);
					var btns = document.querySelectorAll("button[aria-label]");
					for (var i = 0; i < btns.length; i++) {
						var label = btns[i].getAttribute("aria-label") || "";
						if (!/侧边栏|新建会话/.test(label)) continue;
						var bb = btns[i].getBoundingClientRect();
						if (bb.width > 0 && bb.right > right) right = bb.right;
					}
					setLeftPad(Math.max(12, right - Math.round(w) + 12));
				};
				syncPad();
				window.addEventListener("resize", syncPad);
				var mo = new MutationObserver(syncPad);
				mo.observe(document.body, { attributes: true, subtree: true, attributeFilter: ["class", "style"] });
				return function () { window.removeEventListener("resize", syncPad); mo.disconnect(); };
			}, []);

			React.useEffect(function () {
				function onMsg(e) {
					var d = e.data;
					if (!d || d.source !== "pr-app") return;
					if (d.type === "focus-search") {
						var inp = document.getElementById("pr-search");
						if (inp) inp.focus();
						return;
					}
					if (d.type === "state") {
						setCols({ list: d.collections || [], active: d.active || "all" });
						setJobStatus(d.job || null);
						if (typeof d.dark === "boolean") setDark(d.dark);
					}
				}
				window.addEventListener("message", onMsg);
				return function () { window.removeEventListener("message", onMsg); };
			}, []);

			var btnStyle = {
				border: "1px solid " + line, background: dark ? "#20242b" : "#fff",
				color: muted, fontSize: "12px", lineHeight: "18px", padding: "4px 10px",
				borderRadius: "4px", cursor: "pointer", fontFamily: "inherit",
				WebkitAppRegion: "no-drag"
			};
			var tabStyle = function (active) {
				return {
					border: "1px solid " + (active ? "#2b4a6f" : line),
					background: active ? "#2b4a6f" : (dark ? "#20242b" : "#fff"),
					color: active ? "#fff" : muted,
					fontSize: "12px", lineHeight: "18px", padding: "3px 10px",
					borderRadius: "12px", cursor: "pointer", fontFamily: "inherit",
					WebkitAppRegion: "no-drag", whiteSpace: "nowrap"
				};
			};
			var dotColor = { running: "#e0a020", done: "#3f9a5d", partial: "#d0872a", failed: "#c0392b" }[jobStatus] || (dark ? "#5a5f6a" : "#bbb");

			return h("div", { style: { position: "relative", width: "100%", height: "100%", background: bg, display: "flex", flexDirection: "column" } },
				h("div", {
					style: {
						height: "46px", flex: "none", display: "flex", alignItems: "center", gap: "10px",
						padding: "0 12px 0 " + leftPad + "px", background: bg, borderBottom: "1px solid " + line,
						WebkitAppRegion: "drag", cursor: "default"
					}
				},
					h("div", { style: { display: "flex", alignItems: "center", gap: "7px", color: fg, fontSize: "14px", letterSpacing: "1.5px", whiteSpace: "nowrap", paddingLeft: "2px" } },
						h("span", { style: { color: "#2b4a6f" } }, "◈"), "论文阅读"
					),
					h("input", {
						id: "pr-search", placeholder: "搜索标题、章节、正文…（⌘K）", type: "search",
						onInput: function (e) { send({ type: "search", q: e.target.value }); },
						style: {
							flex: "1 1 auto", maxWidth: "520px", minWidth: "120px", padding: "5px 10px",
							border: "1px solid " + line, borderRadius: "4px", background: dark ? "#20242b" : "#fff",
							color: fg, fontSize: "12.5px", fontFamily: "inherit", outline: "none",
							WebkitAppRegion: "no-drag"
						}
					}),
					h("button", {
						style: btnStyle, title: "上传 PDF，自动翻译并建论文",
						onClick: function () { var f = document.getElementById("pr-upload"); if (f) f.click(); }
					}, "＋ 上传 PDF"),
					h("input", {
						id: "pr-upload", type: "file", accept: "application/pdf,.pdf", style: { display: "none" },
						onChange: function (e) {
							var file = e.target.files && e.target.files[0];
							if (!file) return;
							var col = cols.active === "all" ? "drafts" : cols.active;
							fetch("/paper-reader/api/upload?name=" + encodeURIComponent(file.name) + "&collection=" + encodeURIComponent(col), {
								method: "POST", headers: { "content-type": "application/pdf" }, body: file
							}).then(function (r) { return r.json(); }).then(function (d) {
								if (d && d.id) send({ type: "refresh", id: d.id });
								else alert("上传失败：" + ((d && d.error) || "未知错误"));
							}).catch(function (err) { alert("上传失败：" + err.message); });
							e.target.value = "";
						}
					}),
					h("button", {
						style: btnStyle, title: "运行日志 / 给翻译任务下指令",
						onClick: function () { send({ type: "console" }); }
					},
						h("span", { style: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", background: dotColor, marginRight: "6px" } }),
						"日志"
					),
					h("button", {
						style: btnStyle, title: "切换深色 / 浅色",
						onClick: function () { send({ type: "theme" }); }
					}, dark ? "☀️" : "🌙")
				),
				h("iframe", {
					ref: frameRef, src: appUrl, title: "论文阅读", onLoad: onLoad,
					style: { width: "100%", flex: "1 1 auto", minHeight: "0", border: "0", display: "block", background: bg }
				}),
				lost ? h("div", { style: { position: "absolute", top: "52px", right: "14px", display: "flex", gap: "6px", zIndex: 2147481000, opacity: .9 } },
					h("button", { style: Object.assign({}, btnStyle, { background: "rgba(30,34,42,.85)", color: "#f3efe6" }), onClick: function () { if (frameRef.current) frameRef.current.src = appUrl; } }, "◀ 回到阅读"),
					h("button", { style: Object.assign({}, btnStyle, { background: "rgba(30,34,42,.85)", color: "#f3efe6" }), onClick: function () { try { frameRef.current.contentWindow.location.reload(); } catch (e) { frameRef.current.src = frameRef.current.src; } } }, "⟲")
				) : null
			);
		}

		function installMacChromeFix() {
			if (window.__prMacFix) return;
			window.__prMacFix = true;
			var state = { rail: null, header: null };
			var sync = function () {
				var html = document.documentElement;
				var isDarwin = html.getAttribute("data-platform") === "darwin";
				var col = document.querySelector("[class*='_sidebarCol']");
				var w = col ? col.getBoundingClientRect().width : 0;
				var collapsed = w > 0 && w <= 80;
				html.classList.toggle("pr-rail-collapsed", isDarwin && collapsed);
				var rail = col && col.firstElementChild;
				var logo = rail && rail.querySelector("[class*='_logoRow']");
				var header = document.querySelector("[class*='_centerCol'] header");
				if (logo) {
					logo.style.marginTop = (isDarwin && collapsed) ? "26px" : "";
				} else if (rail) {
					rail.style.paddingTop = (isDarwin && collapsed) ? "42px" : "";
				}
				if (header) {
					header.style.paddingLeft = (isDarwin && collapsed) ? "46px" : "";
				}
			};
			sync();
			window.addEventListener("resize", sync);
			var mo = new MutationObserver(sync);
			mo.observe(document.body, { attributes: true, subtree: true, attributeFilter: ["class", "style"] });
			mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-platform", "class"] });
		}

		function apply(ctx) {
			try {
				installMacChromeFix();
				ctx.slots.inject("sidebar.panellist", function () {
					return ctx.slots.register({
						name: "sidebar.panellist",
						id: NAME,
						order: 20,
						label: function () { return "论文阅读"; }
					}, PanelIcon);
				});
				ctx.slots.inject("main", function () {
					return ctx.slots.register({
						name: "main",
						key: NAME,
						label: function () { return "论文阅读"; }
					}, ReaderPanel);
				});
			} catch (err) {
				console.warn("[paper-reader] registration skipped:", err);
			}
		}

		exports.name = NAME;
		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	}
});
