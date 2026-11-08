import { useCallback } from "react";
import { Checkbox } from "../components/ui/checkbox";
import { Switch } from "../components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import {
  installPartitionNames,
  matchingBackupPartitions,
  partitionPolicy,
  wipePartitionNames,
  wipeImagesAvailable,
  LK2ND_PREFIX_BYTES,
  type WritePartitionName,
} from "../../shared/profile";
import { inspector, type SessionSnapshot } from "../edl/session";
import { gptBackupRanges } from "../edl/gpt";
import { size } from "./format";
import StatusIndicator, { type Status } from "./StatusIndicator";

function partitionStatus(
  state: SessionSnapshot,
  name: WritePartitionName | "gpt",
  selected: boolean,
): { status: Status; label: string } {
  const backingUp = state.stage === "backup";
  const saved =
    name === "gpt"
      ? state.gptBackups.length === 2
      : state.backups.some((entry) => entry.name === name);
  const image = state.preparedImages?.some((entry) => entry.name === name);
  const write = state.writes.find((entry) => entry.name === name);
  const progress =
    state.imageProgress.find((entry) => entry.partition === name) ??
    (state.progress?.partition === name ? state.progress : null);

  if (!selected) {
    const matched =
      !backingUp &&
      name !== "gpt" &&
      matchingBackupPartitions(state.build, state.bootMode, state.backups).includes(name);

    if (matched) {
      return { status: "verified", label: "Up to date" };
    }

    return { status: "skipped", label: backingUp ? "Not backing up" : "Not flashing" };
  }

  if ((backingUp && saved) || (!backingUp && write?.status === "written")) {
    return { status: "verified", label: "Done" };
  }

  if (state.error && (progress || write?.status === "writing")) {
    return { status: "failed", label: "Errored" };
  }

  if (state.phase === "cancelled" && progress) {
    return { status: "skipped", label: "Stopped" };
  }

  if (state.busy && progress) {
    if (!progress.totalBytes) {
      return { status: "active", label: progress.label };
    }

    const percent = Math.min(
      100,
      Math.floor((progress.completedBytes / progress.totalBytes) * 100),
    );
    return { status: "active", label: `${progress.label} (${percent}%)` };
  }

  return { status: "pending", label: image ? "Ready" : "Pending" };
}

function ChoiceRow({ name, state }: { name: WritePartitionName; state: SessionSnapshot }) {
  const backingUp = state.stage === "backup";
  const selected = (backingUp ? state.backupPartitions : state.flashPartitions).includes(name);
  const { status, label } = partitionStatus(state, name, selected);
  const locked =
    state.busy ||
    state.stage === "finish" ||
    (backingUp
      ? state.backupDecision !== "pending" || state.backupPath !== null
      : state.selectionLocked || state.writesStarted);

  const change = useCallback(
    (checked: boolean | "indeterminate") => {
      inspector.selectPartition(backingUp ? "backup" : "flash", name, checked === true);
    },
    [backingUp, name],
  );

  const changeLoader = useCallback((checked: boolean) => {
    inspector.selectBootMode(checked ? "complete" : "preserve-lk2nd");
  }, []);

  return (
    <TableRow>
      <TableCell className="choice-cell">
        <label>
          <Checkbox
            aria-label={`${backingUp ? "Back up" : "Flash"} ${name}`}
            checked={selected}
            onCheckedChange={change}
            disabled={locked}
          />
        </label>
      </TableCell>

      <TableCell className="whitespace-normal">
        <code>{name === "oem" ? "metadata" : name}</code>
        {name === "oem" && <small className="metadata-partition-name">OEM</small>}
        <small className="mobile-partition-size">{size(partitionPolicy(name).bytes)}</small>

        {state.stage === "flash" && name === "boot" && (
          <label className="boot-toggle">
            <Switch
              size="sm"
              checked={state.bootMode === "complete"}
              onCheckedChange={changeLoader}
              disabled={locked || !selected}
            />
            Flash lk2nd
          </label>
        )}
      </TableCell>

      <TableCell className="partition-size">{size(partitionPolicy(name).bytes)}</TableCell>
      <TableCell className="partition-status whitespace-normal" aria-live="polite">
        <StatusIndicator status={status}>{label}</StatusIndicator>
      </TableCell>
    </TableRow>
  );
}

function GptChoiceRow({ state }: { state: SessionSnapshot }) {
  const { status, label } = partitionStatus(state, "gpt", state.backupGpt);
  const change = useCallback((checked: boolean | "indeterminate") => {
    inspector.selectGptBackup(checked === true);
  }, []);

  const bytes = state.gpt
    ? gptBackupRanges(state.gpt).reduce((total, range) => total + range.sectorCount * 512, 0)
    : 0;

  return (
    <TableRow>
      <TableCell className="choice-cell">
        <label>
          <Checkbox
            aria-label="Back up GPT"
            checked={state.backupGpt}
            onCheckedChange={change}
            disabled={state.busy || state.backupDecision !== "pending" || state.backupPath !== null}
          />
        </label>
      </TableCell>
      <TableCell className="whitespace-normal">
        GPT
        <small className="partition-note">Both tables + protective MBR</small>
        <small className="mobile-partition-size">{size(bytes)}</small>
      </TableCell>
      <TableCell className="partition-size">{size(bytes)}</TableCell>
      <TableCell className="partition-status whitespace-normal" aria-live="polite">
        <StatusIndicator status={status}>{label}</StatusIndicator>
      </TableCell>
    </TableRow>
  );
}

export default function PartitionChoices({ state }: { state: SessionSnapshot }) {
  const backingUp = state.stage === "backup";
  const selected = backingUp ? state.backupPartitions : state.flashPartitions;
  const preserveBoot =
    !backingUp && selected.includes("boot") && state.bootMode === "preserve-lk2nd";
  const selectedBytes = selected.reduce((total, name) => total + partitionPolicy(name).bytes, 0);
  const gptBytes =
    backingUp && state.backupGpt && state.gpt
      ? gptBackupRanges(state.gpt).reduce((total, range) => total + range.sectorCount * 512, 0)
      : 0;
  const bytes = selectedBytes + gptBytes - (preserveBoot ? LK2ND_PREFIX_BYTES : 0);
  const locked = state.busy || state.selectionLocked || state.writesStarted;

  const choosePreset = useCallback((value: string) => {
    if (value === "update" || value === "clean") {
      inspector.chooseInstallMode(value);
    }
  }, []);
  const preset = wipePartitionNames.every((name) => !selected.includes(name))
    ? "update"
    : wipePartitionNames.every((name) => selected.includes(name))
      ? "clean"
      : "";

  return (
    <>
      <div className="partition-toolbar">
        {state.stage === "flash" ? (
          <ToggleGroup
            type="single"
            variant="outline"
            value={preset}
            onValueChange={choosePreset}
            disabled={locked}
            aria-label="Install type"
          >
            <ToggleGroupItem value="update">Keep data</ToggleGroupItem>
            <ToggleGroupItem value="clean" disabled={locked || !wipeImagesAvailable(state.build)}>
              Clean install
            </ToggleGroupItem>
          </ToggleGroup>
        ) : (
          <span />
        )}
        <span className="partition-total">Total {size(bytes)}</span>
      </div>

      <Table className="targets-table partition-choices">
        <TableHeader>
          <TableRow>
            <TableHead className="choice-cell">{backingUp ? "Back up" : "Flash"}</TableHead>
            <TableHead>Partition</TableHead>
            <TableHead className="partition-size">Size</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {installPartitionNames("clean").map((name) => (
            <ChoiceRow key={name} name={name} state={state} />
          ))}
          {backingUp && <GptChoiceRow state={state} />}
        </TableBody>
      </Table>
    </>
  );
}
