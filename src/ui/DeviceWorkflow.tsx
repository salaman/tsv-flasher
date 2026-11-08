import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  BoltIcon,
  CheckIcon,
  LinkIcon,
} from "@heroicons/react/20/solid";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { inspector, type SessionSnapshot } from "../edl/session";
import { size } from "./format";
import StatusIndicator, { type Status } from "./StatusIndicator";
import ConnectionChecks from "./ConnectionChecks";
import PartitionChoices from "./PartitionChoices";
import WorkflowSteps from "./WorkflowSteps";

interface StepProps {
  state: SessionSnapshot;
}

function checkStatus(complete: boolean, active: boolean, failed = false): Status {
  if (failed) {
    return "failed";
  }

  if (complete) {
    return "verified";
  }

  if (active) {
    return "active";
  }

  return "pending";
}

function exportDiagnostics() {
  const report = { ...inspector.getSnapshot(), ...inspector.getReport() };
  const json = JSON.stringify(
    report,
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = `thinksmart-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  anchor.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DisconnectButton({ state }: StepProps) {
  if (!state.busy && !state.connected && !state.error) {
    return null;
  }

  let label = "Disconnect";

  if (state.phase === "closing") {
    label = "Stopping…";
  } else if (state.busy) {
    label = "Stop";
  }

  return (
    <Button
      variant="outline"
      type="button"
      onClick={inspector.disconnect}
      disabled={state.phase === "closing"}
    >
      {label}
    </Button>
  );
}

function ConnectionStep({ state }: StepProps) {
  const failedAt = state.error ? state.failedPhase : null;
  const identityPhases = ["choosing", "opening", "identity"];
  const retryProgrammer = !state.prepared && failedAt === "preparing";
  const canContinue = state.gpt && state.connected;
  let connectLabel = "Connect device";

  if (retryProgrammer) {
    connectLabel = "Retry programmer download";
  } else if (state.error && state.prepared) {
    connectLabel = "Retry connection";
  } else if (!state.prepared && state.phase === "cancelled") {
    connectLabel = "Prepare programmer";
  }

  return (
    <>
      <h2 id="step-title">Connect & verify</h2>
      <p>
        To enter EDL, power the device off, hold both volume buttons, then power it on while holding
        them. Connect USB and select <code>QUSB__BULK</code>.
      </p>

      <ConnectionChecks
        tools="verified"
        programmer={checkStatus(
          state.prepared,
          state.phase === "preparing",
          failedAt === "preparing",
        )}
        identity={checkStatus(
          Boolean(state.identity),
          identityPhases.includes(state.phase),
          failedAt !== null && identityPhases.includes(failedAt),
        )}
        upload={checkStatus(
          state.programmerUploaded,
          state.phase === "uploading",
          failedAt === "uploading",
        )}
        storage={checkStatus(
          Boolean(state.storage),
          state.phase === "storage",
          failedAt === "storage",
        )}
        gpt={checkStatus(
          Boolean(state.gpt),
          state.phase === "gpt",
          failedAt === "gpt" ||
            Boolean(state.gpt && (!state.gpt.layoutMatches || !state.gpt.capacityConfirmed)),
        )}
      />

      <div className="help">
        <p>
          With lk2nd installed: <code>adb reboot bootloader</code>, then{" "}
          <code>fastboot oem reboot-edl</code>. Close other EDL tools first.
        </p>
      </div>

      <div className="actions">
        {canContinue ? (
          <Button
            type="button"
            onClick={inspector.continue}
            disabled={state.busy || !state.gpt?.layoutMatches || !state.gpt.capacityConfirmed}
          >
            Continue to backup
            <ArrowRightIcon aria-hidden="true" focusable="false" />
          </Button>
        ) : (
          <Button
            type="button"
            onClick={state.prepared ? inspector.connect : inspector.prepare}
            disabled={
              state.busy ||
              state.connected ||
              (!state.prepared && !retryProgrammer && state.phase !== "cancelled")
            }
          >
            {connectLabel}
            <LinkIcon aria-hidden="true" focusable="false" />
          </Button>
        )}

        <DisconnectButton state={state} />
      </div>
    </>
  );
}

function BackupStep({ state }: StepProps) {
  const backupStarted = state.backupPath !== null;
  const backupComplete = state.backupDecision === "complete";
  const disabled = state.busy || !state.connected;

  return (
    <>
      <h2 id="step-title">Backup</h2>
      <Alert className="my-6" role="note">
        <AlertDescription>
          Flashing overwrites the selected partitions. Back up anything you want to keep.
        </AlertDescription>
      </Alert>
      <PartitionChoices state={state} />

      {state.backupPath && (
        <p className="backup-location">
          <code>{state.backupPath}</code>
        </p>
      )}

      <div className="actions">
        {backupComplete ? (
          <Button type="button" onClick={inspector.continue} disabled={disabled}>
            Continue to flash
            <ArrowRightIcon aria-hidden="true" focusable="false" />
          </Button>
        ) : (
          <>
            <Button
              type="button"
              onClick={inspector.backup}
              disabled={
                disabled || backupStarted || (!state.backupPartitions.length && !state.backupGpt)
              }
            >
              Back up
              <ArrowDownTrayIcon aria-hidden="true" focusable="false" />
            </Button>
            <DisconnectButton state={state} />
            <Button
              variant="outline"
              type="button"
              onClick={inspector.skipBackup}
              disabled={disabled || backupStarted}
            >
              Skip backup
            </Button>
          </>
        )}
        {backupComplete && <DisconnectButton state={state} />}
      </div>
    </>
  );
}

function FlashStep({ state }: StepProps) {
  const [acceptsOverwrite, setAcceptsOverwrite] = useState(false);
  const hasSelection = state.flashPartitions.length > 0;
  const disabled = state.busy || !state.connected || state.selectionLocked || state.writesStarted;

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      inspector.flash(acceptsOverwrite);
      setAcceptsOverwrite(false);
    },
    [acceptsOverwrite],
  );

  const changeConfirmation = useCallback((checked: boolean | "indeterminate") => {
    setAcceptsOverwrite(checked === true);
  }, []);

  return (
    <>
      <h2 id="step-title">Flash</h2>
      <PartitionChoices state={state} />

      <form className="confirmation" onSubmit={submit}>
        {hasSelection && !state.writesStarted && (
          <label className="checkbox-label">
            <Checkbox
              checked={acceptsOverwrite}
              onCheckedChange={changeConfirmation}
              disabled={state.busy || !state.connected}
            />
            I understand the selected partitions will be overwritten.
          </label>
        )}

        <div className="actions">
          {hasSelection ? (
            <Button type="submit" disabled={disabled || !acceptsOverwrite}>
              Flash device
              <BoltIcon aria-hidden="true" focusable="false" />
            </Button>
          ) : (
            <Button type="button" onClick={inspector.continue} disabled={disabled}>
              Finish
              <CheckIcon aria-hidden="true" focusable="false" />
            </Button>
          )}
          <DisconnectButton state={state} />
        </div>
      </form>
    </>
  );
}

function FinishStep({ state }: StepProps) {
  const canRestart = ["complete", "unchanged"].includes(state.phase);
  let title = state.writes.length ? "Flash complete" : "Nothing to flash";

  if (state.phase === "finished") {
    title = "Device restarted";
  }

  return (
    <>
      <h2 id="step-title">
        <StatusIndicator status="verified">{title}</StatusIndicator>
      </h2>
      <PartitionChoices state={state} />

      <div className="actions">
        <Button
          type="button"
          onClick={inspector.restart}
          disabled={state.busy || !state.connected || !canRestart}
        >
          Restart device
          <ArrowPathIcon aria-hidden="true" focusable="false" />
        </Button>
        <DisconnectButton state={state} />
        <Button variant="outline" type="button" onClick={exportDiagnostics}>
          Save report
        </Button>
      </div>
    </>
  );
}

function DeviceDetails({ state }: StepProps) {
  if (!state.gpt) {
    return null;
  }

  return (
    <details className="device-details">
      <summary>
        Device details · {state.connected ? "Connected" : "Disconnected"} ·{" "}
        {size(state.gpt.totalSectors * 512n)}
      </summary>

      <dl>
        <dt>HWID</dt>
        <dd>
          <code>{state.identity?.hardwareId}</code>
        </dd>
        <dt>Chip serial</dt>
        <dd>
          <code>{state.identity?.serial}</code>
        </dd>
        <dt>OEM key</dt>
        <dd>
          <code>{state.identity?.oemKeyHash}</code>
        </dd>
        <dt>Disk GUID</dt>
        <dd>
          <code>{state.gpt.primary.diskGuid}</code>
        </dd>
      </dl>

      <div className="table-scroll">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Partition</TableHead>
              <TableHead>Start LBA</TableHead>
              <TableHead>Size</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.gpt.partitions.map((partition) => (
              <TableRow key={partition.uniqueGuid}>
                <TableCell>{partition.name}</TableCell>
                <TableCell>{String(partition.firstLba)}</TableCell>
                <TableCell>{size(partition.bytes)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </details>
  );
}

function OperationLog({ entries }: { entries: SessionSnapshot["logs"] }) {
  const [debug, setDebug] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  const followLog = useRef(true);
  const visible = entries.filter((entry) => debug || entry.level !== "debug");

  useEffect(() => {
    if (visible.length && followLog.current && element.current) {
      element.current.scrollTop = element.current.scrollHeight;
    }
  }, [visible]);

  const changeDebug = useCallback((checked: boolean | "indeterminate") => {
    setDebug(checked === true);
  }, []);

  const trackScroll = useCallback(() => {
    const log = element.current;

    if (!log) {
      return;
    }

    followLog.current = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  }, []);

  return (
    <section className="log-section" aria-labelledby="log-title">
      <div className="section-heading">
        <h2 id="log-title">Log</h2>
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={exportDiagnostics}
          disabled={!entries.length}
        >
          Export JSON
        </Button>
      </div>

      <label className="checkbox-label">
        <Checkbox checked={debug} onCheckedChange={changeDebug} />
        Show USB / protocol details
      </label>

      <div
        className="log"
        ref={element}
        onScroll={trackScroll}
        tabIndex={0}
        aria-label="Operation log"
      >
        {visible.length ? (
          visible.map((entry) => (
            <div className={`log-entry ${entry.level}`} key={entry.id}>
              <time dateTime={entry.time}>{entry.time.slice(11, 23)}</time>
              <span>{entry.source}</span>
              <span>{entry.message}</span>
            </div>
          ))
        ) : (
          <p>{entries.length ? "USB / protocol details are hidden." : "No operations yet."}</p>
        )}
      </div>

      <small>Reports include device serial numbers.</small>
    </section>
  );
}

export default function DeviceWorkflow({ onBack }: { onBack: () => void }) {
  const state = useSyncExternalStore(inspector.subscribe, inspector.getSnapshot);

  useEffect(() => {
    if (inspector.getSnapshot().phase === "idle") {
      inspector.prepare();
    }
  }, []);

  const returnToImage = useCallback(async () => {
    const current = inspector.getSnapshot();
    if (current.busy || current.writesStarted) {
      return;
    }

    await inspector.disconnect();
    const disconnected = inspector.getSnapshot();
    if (!disconnected.busy && !disconnected.connected && !disconnected.error) {
      onBack();
    }
  }, [onBack]);

  const previousSteps = useMemo(
    () => ({
      image: returnToImage,
      connection: () => inspector.back("connection"),
      backup: () => inspector.back("backup"),
      flash: () => inspector.back("flash"),
    }),
    [returnToImage],
  );

  let recoveryMessage = "Re-enter EDL before connecting again.";

  if (state.writesStarted) {
    recoveryMessage = "Save the report. Recover with native EDL tools before restarting.";
  } else if (state.connected) {
    recoveryMessage = "Go back to retry.";
  }

  return (
    <>
      <WorkflowSteps
        current={state.stage}
        failed={Boolean(state.error)}
        completed={state.stage === "finish"}
        backupSkipped={state.backupDecision === "skipped"}
        onBack={previousSteps}
        disabled={state.busy || state.writesStarted}
      />

      <div className="selected-image">
        <span>
          {state.build?.name} {state.build?.version} <small>{state.build?.id}</small>
        </span>
      </div>

      <section className="step-panel" aria-labelledby="step-title">
        {state.stage === "connection" && <ConnectionStep state={state} />}
        {state.stage === "backup" && <BackupStep state={state} />}
        {state.stage === "flash" && (
          // A changed target set must not inherit the previous overwrite confirmation.
          <FlashStep key={[state.bootMode, ...state.flashPartitions].join(":")} state={state} />
        )}
        {state.stage === "finish" && <FinishStep state={state} />}

        {state.error && (
          <Alert className="my-6" variant="destructive">
            <AlertTitle>
              <StatusIndicator status="failed">
                {state.writesStarted ? "Flashing stopped" : "Operation stopped"}
              </StatusIndicator>
            </AlertTitle>
            <AlertDescription>
              <p>{state.error}</p>
              <p>{recoveryMessage}</p>
            </AlertDescription>
          </Alert>
        )}
      </section>

      <DeviceDetails state={state} />
      <OperationLog entries={state.logs} />
    </>
  );
}
