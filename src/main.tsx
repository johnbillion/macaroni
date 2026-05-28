import { render } from "preact";
import { App } from "./components/App";
import { AppProvider } from "./state/context";
import "./styles.css";

if (import.meta.env.DEV) {
	import("@tauri-apps/plugin-log").then((log) => {
		const format = (args: unknown[]) =>
			args
				.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
				.join(" ");
		const originalError = console.error.bind(console);
		console.error = (...args) => {
			originalError(...args);
			log.error(format(args));
		};
		const originalAssert = console.assert.bind(console);
		console.assert = (condition?: boolean, ...args: unknown[]) => {
			originalAssert(condition, ...args);
			if (!condition) {
				log.error(`Assertion failed: ${format(args)}`);
			}
		};
		window.addEventListener("error", (e) => {
			log.error(`Uncaught: ${e.message} at ${e.filename}:${e.lineno}:${e.colno}`);
		});
		window.addEventListener("unhandledrejection", (e) => {
			log.error(`Unhandled rejection: ${String(e.reason)}`);
		});
	});
}

render(
	<AppProvider>
		<App />
	</AppProvider>,
	document.getElementById("root") as HTMLElement,
);
