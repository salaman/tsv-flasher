import { ChevronDownIcon } from "@heroicons/react/20/solid";
import { Collapsible } from "radix-ui";
import type { FirmwareBuild } from "../../shared/catalog";
import { Button } from "../components/ui/button";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";

function BuildOption({ build }: { build: FirmwareBuild }) {
  return (
    <label className="hover:bg-accent/50 has-[[data-state=checked]]:border-primary flex cursor-pointer items-start gap-3 rounded-lg border p-4">
      <RadioGroupItem
        className="mt-1"
        value={build.id}
        aria-label={`${build.name} ${build.version}, ${build.date}`}
      />
      <span className="grid min-w-0 gap-1">
        <strong>
          {build.name} {build.version}
        </strong>
        <small className="text-sm">
          <time dateTime={build.date}>{build.date}</time> /{" "}
          <a
            className="font-mono"
            href={`https://github.com/salaman/tsv-lineage/commit/${build.sourceRevision}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`View source commit ${build.sourceRevision} on GitHub`}
          >
            {build.sourceRevision.slice(0, 7)}
          </a>
        </small>
        <span className="text-sm wrap-anywhere">{build.description}</span>
      </span>
    </label>
  );
}

interface BuildSelectorProps {
  newest: FirmwareBuild;
  older: readonly FirmwareBuild[];
  selectedId: string;
  onSelect: (id: string) => void;
}

export default function BuildSelector({ newest, older, selectedId, onSelect }: BuildSelectorProps) {
  const selectedOlder = older.find((build) => build.id === selectedId);

  return (
    <RadioGroup aria-labelledby="image-title" value={selectedId} onValueChange={onSelect}>
      <BuildOption build={newest} />
      {older.length > 0 && (
        <Collapsible.Root defaultOpen={Boolean(selectedOlder)}>
          <Collapsible.Trigger asChild>
            <Button className="group" variant="ghost" size="sm" type="button">
              <ChevronDownIcon className="group-data-[state=open]:rotate-180" aria-hidden="true" />
              Older builds
              {selectedOlder && (
                <span className="text-muted-foreground group-data-[state=open]:hidden">
                  ({selectedOlder.date} selected)
                </span>
              )}
            </Button>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div className="mt-3 grid gap-3">
              {older.map((build) => (
                <BuildOption key={build.id} build={build} />
              ))}
            </div>
          </Collapsible.Content>
        </Collapsible.Root>
      )}
    </RadioGroup>
  );
}
