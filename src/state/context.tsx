import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext, useMemo, useReducer } from "preact/hooks";
import { type Action, type AppState, initialState, reducer } from "./store";

type Dispatch = (action: Action) => void;

const StateCtx = createContext<AppState>(initialState);
const DispatchCtx = createContext<Dispatch>(() => undefined);

export function AppProvider({ children }: { children: ComponentChildren }) {
	const [state, dispatch] = useReducer(reducer, initialState);
	const memo = useMemo(() => state, [state]);
	return (
		<StateCtx.Provider value={memo}>
			<DispatchCtx.Provider value={dispatch}>{children}</DispatchCtx.Provider>
		</StateCtx.Provider>
	);
}

export const useAppState = () => useContext(StateCtx);
export const useDispatch = () => useContext(DispatchCtx);
