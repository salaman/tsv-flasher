import { ArrowPathIcon, ArrowRightIcon } from "@heroicons/react/20/solid";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { Catalog } from "../shared/catalog";
import { fetchCatalog } from "./catalog";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { RadioGroup, RadioGroupItem } from "./components/ui/radio-group";
import ConnectionChecks from "./ui/ConnectionChecks";
import WorkflowSteps from "./ui/WorkflowSteps";
import "./App.css";

type CatalogState =
  | { status: "loading" }
  | { status: "failed"; error: string }
  | { status: "ready"; catalog: Catalog; selectedId: string };

function unsupportedBrowserReason(): string | null {
  if (!window.isSecureContext) {
    return "USB and file access require a secure connection. Open this page over HTTPS or localhost.";
  }

  if (typeof navigator.usb?.requestDevice !== "function") {
    return "WebUSB is unavailable in this browser. Use desktop Chrome or Edge, not an embedded preview.";
  }

  if (
    typeof navigator.storage?.getDirectory !== "function" ||
    typeof navigator.storage?.estimate !== "function"
  ) {
    return "This browser does not provide the private file storage needed to prepare images.";
  }

  if (typeof window.crypto?.randomUUID !== "function") {
    return "Secure browser cryptography is unavailable. Use an up-to-date desktop Chrome or Edge.";
  }

  return null;
}

export default function App() {
  const [Workflow, setWorkflow] = useState<ComponentType<{ onBack: () => void }> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: "loading" });
  const catalogRequest = useRef<AbortController | null>(null);
  const catalog = catalogState.status === "ready" ? catalogState.catalog : null;
  const selectedId = catalogState.status === "ready" ? catalogState.selectedId : null;
  const browserIssue = unsupportedBrowserReason();
  const supported = browserIssue === null;
  const supportsBackup = typeof window.showDirectoryPicker === "function";
  const loadingConnection = loading || error !== null;

  const loadCatalog = useCallback(() => {
    catalogRequest.current?.abort();
    const controller = new AbortController();
    catalogRequest.current = controller;
    void fetchCatalog(controller.signal).then(
      (loaded) => {
        if (!controller.signal.aborted) {
          setCatalogState({ status: "ready", catalog: loaded, selectedId: loaded.builds[0]!.id });
        }
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) {
          setCatalogState({
            status: "failed",
            error:
              cause instanceof Error ? cause.message : "The build manifest could not be loaded.",
          });
        }
      },
    );
  }, []);

  const retryCatalog = useCallback(() => {
    setCatalogState({ status: "loading" });
    loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    loadCatalog();
    return () => catalogRequest.current?.abort();
  }, [loadCatalog]);

  const selectImage = useCallback((id: string) => {
    setCatalogState((previous) =>
      previous.status === "ready" ? { ...previous, selectedId: id } : previous,
    );
  }, []);

  /** Load protocol/crypto code only after the user selects an image and continues. */
  const continueToDevice = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      if (!catalog || !selectedId) {
        throw new Error("Select an available image before continuing.");
      }
      const [feature, { inspector }] = await Promise.all([
        import("./ui/DeviceWorkflow"),
        import("./edl/session"),
      ]);
      inspector.selectBuild(catalog, selectedId);
      setWorkflow(() => feature.default);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connection tools could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [catalog, selectedId]);

  const returnToImage = useCallback(() => {
    setWorkflow(null);
    setError(null);
  }, []);
  const previousSteps = useMemo(() => ({ image: returnToImage }), [returnToImage]);

  return (
    <main>
      <header className="page-header">
        <h1>ThinkSmart View LineageOS installer</h1>
      </header>

      {Workflow ? (
        <Workflow onBack={returnToImage} />
      ) : (
        <>
          <WorkflowSteps
            current={loadingConnection ? "connection" : "image"}
            failed={Boolean(error)}
            onBack={loadingConnection ? previousSteps : undefined}
            disabled={loading}
          />
          {!loadingConnection && (
            <div className="page-intro">
              <p>
                An experimental web-based flasher for the Lenovo ThinkSmart View. Back up your
                device and install LineageOS directly from desktop Chrome or Edge.
              </p>
              <p className="help">
                Windows needs WinUSB, install the driver via{" "}
                <a href="https://zadig.akeo.ie/" target="_blank" rel="noreferrer">
                  Zadig
                </a>
                . Linux needs USB permissions and release of qcserial. macOS needs an unclaimed USB
                interface.
              </p>
            </div>
          )}
          <section
            className="step-panel"
            aria-labelledby={loadingConnection ? "connection-title" : "image-title"}
          >
            {loadingConnection ? (
              <>
                <h2 id="connection-title">Connect & verify</h2>
                <ConnectionChecks tools={error ? "failed" : "active"} />

                {error && (
                  <Alert className="my-6" variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                {error && (
                  <div className="actions">
                    <Button type="button" onClick={continueToDevice} disabled={!supported}>
                      Retry connection tools
                      <ArrowPathIcon aria-hidden="true" focusable="false" />
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <>
                <h2 id="image-title">Select an image</h2>

                {catalogState.status === "loading" && (
                  <p role="status">Loading available images...</p>
                )}
                {catalogState.status === "failed" && (
                  <>
                    <Alert className="my-6" variant="destructive">
                      <AlertDescription>{catalogState.error}</AlertDescription>
                    </Alert>
                    <Button variant="outline" type="button" onClick={retryCatalog}>
                      Retry loading images
                    </Button>
                  </>
                )}
                {catalog && (
                  <RadioGroup
                    className="image-options"
                    aria-labelledby="image-title"
                    value={selectedId ?? ""}
                    onValueChange={selectImage}
                  >
                    {catalog.builds.map((build) => (
                      <label
                        className="image-option hover:bg-accent/50 has-[[data-state=checked]]:border-primary rounded-lg border"
                        key={build.id}
                      >
                        <RadioGroupItem
                          value={build.id}
                          aria-label={`${build.name} ${build.version}`}
                        />
                        <span>
                          <strong>
                            {build.name} {build.version}
                          </strong>
                          <small>
                            {build.id} / <time dateTime={build.date}>{build.date}</time>
                          </small>
                          <span>{build.description}</span>
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
                )}

                {browserIssue && (
                  <Alert className="my-6">
                    <AlertDescription>{browserIssue}</AlertDescription>
                  </Alert>
                )}

                {supported && !supportsBackup && (
                  <Alert className="my-6">
                    <AlertDescription>
                      This browser cannot save backups to a folder. You can continue without a
                      backup.
                    </AlertDescription>
                  </Alert>
                )}

                <Button
                  type="button"
                  onClick={continueToDevice}
                  disabled={!supported || loading || !catalog || !selectedId}
                >
                  Continue
                  <ArrowRightIcon aria-hidden="true" focusable="false" />
                </Button>
              </>
            )}
          </section>

          <section className="log-section">
            <h2>Log</h2>
            <div className="log">
              <p>No operations yet.</p>
            </div>
          </section>
        </>
      )}

      <footer>
        <a href="https://github.com/salaman/tsv-lineage" target="_blank" rel="noreferrer">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
          </svg>
          GitHub
        </a>
      </footer>
    </main>
  );
}
