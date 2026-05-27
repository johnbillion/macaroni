import { render } from "preact";
import { App } from "./components/App";
import { AppProvider } from "./state/context";
import "./styles.css";

render(
	<AppProvider>
		<App />
	</AppProvider>,
	document.getElementById("root") as HTMLElement,
);
