This is a Tauri and Preact app that displays an inbox for a HackerOne bug bounty program.

## Important principles

| Principle | Approach |
|---|---|
| **Declarative** | Preact components as pure functions of props and state |
| **Polymorphic** | TypeScript discriminated unions + render maps for revision types, content types, etc. |
| **Reactive** | `useState` / `useContext` with lifted state; `useReducer` for centralized transitions |
| **State-driven** | Single global store via Context + `useReducer`; UI is a projection of state |
| **Testable** | Trait-based Rust services with mock implementations; transport-layer mocking on the frontend |
| **Pure views** | No side effects in components; actions dispatched via context callbacks |
| **Minimal frontend logic** | The frontend renders and captures user intent; business logic lives in Rust |
