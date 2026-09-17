import './Checkbox.css';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}

const Checkbox = (props: CheckboxProps) => {
  const toggle = () => {
    if (!props.disabled) props.onChange(!props.checked);
  };
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      aria-label={props.label}
      class="checkbox"
      classList={{ checked: props.checked }}
      disabled={props.disabled}
      onClick={toggle}
    >
      <svg class="checkbox-mark" viewBox="0 0 10 10" aria-hidden="true">
        <path
          d="M1.6 5.4 4 7.8 8.4 2.4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  );
};

export default Checkbox;
