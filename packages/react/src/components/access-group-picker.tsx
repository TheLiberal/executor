import { Checkbox } from "./checkbox";
import { Label } from "./label";

// ---------------------------------------------------------------------------
// A checkbox list for choosing the access groups a connection or toolkit is
// granted to. Multi-select with OR semantics on the server: a member of ANY
// checked group may use the target; nothing checked = unrestricted.
// ---------------------------------------------------------------------------

export type AccessGroupOption = {
  readonly id: string;
  readonly name: string;
};

export function AccessGroupPicker(props: {
  groups: readonly AccessGroupOption[];
  selected: readonly string[];
  onChange: (selected: readonly string[]) => void;
  disabled?: boolean;
  idPrefix?: string;
}) {
  const prefix = props.idPrefix ?? "access-group";
  const toggle = (id: string, checked: boolean) => {
    const without = props.selected.filter((candidate) => candidate !== id);
    props.onChange(checked ? [...without, id] : without);
  };

  if (props.groups.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
        No access groups yet.
      </p>
    );
  }

  return (
    <div
      role="group"
      aria-label="Access groups"
      className="max-h-56 space-y-px overflow-y-auto rounded-md border border-border p-1"
    >
      {props.groups.map((group) => {
        const id = `${prefix}-${group.id}`;
        const checked = props.selected.includes(group.id);
        return (
          <div
            key={group.id}
            className="flex items-center gap-3 rounded-sm px-2 py-1.5 transition-colors hover:bg-muted/40"
          >
            <Checkbox
              id={id}
              checked={checked}
              disabled={props.disabled}
              onCheckedChange={(value) => toggle(group.id, value === true)}
            />
            <Label htmlFor={id} className="flex-1 cursor-pointer text-sm font-normal">
              {group.name}
            </Label>
          </div>
        );
      })}
    </div>
  );
}
