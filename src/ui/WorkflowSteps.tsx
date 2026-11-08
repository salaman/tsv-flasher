import { CheckIcon } from "@heroicons/react/20/solid";

const steps = [
  { id: "image", title: "Image" },
  { id: "connection", title: "Connect & verify" },
  { id: "backup", title: "Backup" },
  { id: "flash", title: "Flash" },
  { id: "finish", title: "Finish" },
] as const;

type WorkflowStep = (typeof steps)[number]["id"];

export default function WorkflowSteps({
  current,
  failed = false,
  completed = false,
  backupSkipped = false,
  onBack,
  disabled = false,
}: {
  current: WorkflowStep;
  failed?: boolean;
  completed?: boolean;
  backupSkipped?: boolean;
  onBack?: Partial<Record<WorkflowStep, () => void>>;
  disabled?: boolean;
}) {
  const active = steps.findIndex((step) => step.id === current);

  return (
    <ol className="workflow-steps" aria-label="Installation steps">
      {steps.map((step, index) => {
        const selected = index === active;
        const complete = index < active || (selected && completed && !failed);
        const errored = selected && failed;
        const skipped = complete && step.id === "backup" && backupSkipped;
        const navigate = complete ? onBack?.[step.id] : undefined;
        let className = "";

        if (errored) {
          className = "current failed";
        } else if (complete) {
          className = skipped ? "skipped" : "done";
        } else if (selected) {
          className = "current";
        }

        const title = (
          <>
            <span>{index + 1}</span> {step.title}
            {complete && !skipped && (
              <CheckIcon
                className="step-complete"
                role="img"
                aria-label="Completed"
                aria-hidden={false}
                focusable="false"
              />
            )}
          </>
        );

        return (
          <li
            key={step.id}
            className={className}
            aria-current={selected ? "step" : undefined}
            title={skipped ? "Backup skipped" : undefined}
          >
            {navigate ? (
              <button type="button" onClick={navigate} disabled={disabled}>
                {title}
              </button>
            ) : (
              <span className="step-name">{title}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
