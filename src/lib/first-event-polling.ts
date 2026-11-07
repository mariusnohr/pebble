// Returns the effect cleanup; aborting also prevents a stale response after navigation.
export function pollFirstEvent(projectId: string, onReceived: (time: string) => void) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let request: AbortController | undefined;
  let stopped = false;

  function pause() {
    clearInterval(timer);
    request?.abort();
    request = undefined;
  }

  async function poll() {
    if (stopped || document.visibilityState !== "visible" || request) return;
    const controller = new AbortController();
    request = controller;
    try {
      const response = await fetch(`/api/projects/${projectId}/first-event`, {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (response.status === 404) {
        stop();
        return;
      }
      if (!response.ok) return;
      const data: { firstEventAt: string | null } = await response.json();
      if (!controller.signal.aborted && data.firstEventAt) {
        stop();
        onReceived(data.firstEventAt);
      }
    } catch {
      // Transient failures retry on the next visible tick.
    } finally {
      if (request === controller) request = undefined;
    }
  }

  function visibilityChanged() {
    pause();
    if (!stopped && document.visibilityState === "visible") {
      void poll();
      timer = setInterval(() => void poll(), 5000);
    }
  }

  function stop() {
    stopped = true;
    pause();
    document.removeEventListener("visibilitychange", visibilityChanged);
  }

  document.addEventListener("visibilitychange", visibilityChanged);
  visibilityChanged();
  return stop;
}
