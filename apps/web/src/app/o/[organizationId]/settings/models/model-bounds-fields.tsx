/** Shared native form for both authority requests. Every spending ceiling is entered explicitly. */
export function ModelBoundsFields({ qualification = false }: { qualification?: boolean }) {
  return (
    <fieldset className="fields">
      <legend>Spending and execution limits</legend>
      <p className="muted">
        Limits apply to each job and remain subject to the organization budget and model policy. One
        US dollar is 1,000,000 micro-USD.
      </p>
      <label>
        Maximum calls
        <input
          name="maxCalls"
          type="number"
          required
          min="1"
          max="1000"
          {...(qualification ? { value: 1, readOnly: true } : {})}
        />
      </label>
      <label>
        Maximum input tokens per call
        <input name="maxInputTokens" type="number" required min="1" max="2147483647" />
      </label>
      <label>
        Maximum output tokens per call
        <input name="maxOutputTokens" type="number" required min="1" max="2147483647" />
      </label>
      <label>
        Maximum total tokens per job
        <input name="maxTotalTokens" type="number" required min="1" max="9007199254740991" />
      </label>
      <label>
        Maximum cost per job (micro-USD)
        <input name="maxCostMicros" type="number" required min="0" max="9007199254740991" />
      </label>
      <label>
        Time limit per job (seconds)
        <input name="timeoutSeconds" type="number" required min="1" max="86400" />
      </label>
    </fieldset>
  );
}
