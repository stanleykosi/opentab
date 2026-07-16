import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { useId } from 'react';
import { cn } from '../lib/cn.js';

interface FieldChromeProps {
  id: string;
  label: string;
  description?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}

function FieldChrome({ children, description, error, id, label, required }: FieldChromeProps) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="ot-field">
      <label className="ot-field__label" htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {children}
      {description ? (
        <p className="ot-field__description" id={descriptionId}>
          {description}
        </p>
      ) : null}
      {error ? (
        <p className="ot-field__error" id={errorId}>
          <span aria-hidden="true">!</span> {error}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'aria-describedby' | 'id' | 'size'> {
  id?: string;
  label: string;
  description?: string;
  error?: string;
}

export function TextField({
  className,
  description,
  error,
  id,
  label,
  required,
  ...props
}: TextFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const describedBy =
    [description ? `${fieldId}-description` : '', error ? `${fieldId}-error` : '']
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <FieldChrome
      id={fieldId}
      label={label}
      {...(required === undefined ? {} : { required })}
      {...(description === undefined ? {} : { description })}
      {...(error === undefined ? {} : { error })}
    >
      <input
        {...props}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={cn('ot-input', className)}
        id={fieldId}
        required={required}
      />
    </FieldChrome>
  );
}

export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'aria-describedby' | 'id'> {
  id?: string;
  label: string;
  description?: string;
  error?: string;
}

export function TextArea({
  className,
  description,
  error,
  id,
  label,
  required,
  ...props
}: TextAreaProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const describedBy =
    [description ? `${fieldId}-description` : '', error ? `${fieldId}-error` : '']
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <FieldChrome
      id={fieldId}
      label={label}
      {...(required === undefined ? {} : { required })}
      {...(description === undefined ? {} : { description })}
      {...(error === undefined ? {} : { error })}
    >
      <textarea
        {...props}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={cn('ot-input ot-textarea', className)}
        id={fieldId}
        required={required}
      />
    </FieldChrome>
  );
}

export interface SelectFieldProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'aria-describedby' | 'id'> {
  id?: string;
  label: string;
  description?: string;
  error?: string;
}

export function SelectField({
  children,
  className,
  description,
  error,
  id,
  label,
  required,
  ...props
}: SelectFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const describedBy =
    [description ? `${fieldId}-description` : '', error ? `${fieldId}-error` : '']
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <FieldChrome
      id={fieldId}
      label={label}
      {...(required === undefined ? {} : { required })}
      {...(description === undefined ? {} : { description })}
      {...(error === undefined ? {} : { error })}
    >
      <select
        {...props}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={cn('ot-input ot-select', className)}
        id={fieldId}
        required={required}
      >
        {children}
      </select>
    </FieldChrome>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  id?: string;
  label: string;
  description?: string;
}

export function Checkbox({ className, description, id, label, ...props }: CheckboxProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const descriptionId = description ? `${fieldId}-description` : undefined;
  return (
    <div className="ot-check">
      <input
        {...props}
        aria-describedby={descriptionId}
        className={cn('ot-check__control', className)}
        id={fieldId}
        type="checkbox"
      />
      <div>
        <label className="ot-check__label" htmlFor={fieldId}>
          {label}
        </label>
        {description ? (
          <p className="ot-field__description" id={descriptionId}>
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export interface RadioOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface RadioGroupProps {
  legend: string;
  name: string;
  options: readonly RadioOption[];
  value?: string;
  onChange?: (value: string) => void;
  description?: string;
  error?: string;
  disabled?: boolean;
}

export function RadioGroup({
  description,
  disabled,
  error,
  legend,
  name,
  onChange,
  options,
  value,
}: RadioGroupProps) {
  const generatedId = useId();
  const descriptionId = description ? `${generatedId}-description` : undefined;
  const errorId = error ? `${generatedId}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <fieldset aria-describedby={describedBy} className="ot-radio-group">
      <legend>{legend}</legend>
      {description ? (
        <p className="ot-field__description" id={descriptionId}>
          {description}
        </p>
      ) : null}
      <div className="ot-radio-group__options">
        {options.map((option) => {
          const optionId = `${generatedId}-${option.value.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
          const optionDescriptionId = option.description ? `${optionId}-description` : undefined;
          return (
            <label className="ot-radio" htmlFor={optionId} key={option.value}>
              <input
                checked={value === option.value}
                disabled={disabled || option.disabled}
                id={optionId}
                name={name}
                onChange={() => onChange?.(option.value)}
                type="radio"
                value={option.value}
                {...(optionDescriptionId === undefined
                  ? {}
                  : { 'aria-describedby': optionDescriptionId })}
              />
              <span>
                <strong>{option.label}</strong>
                {option.description ? (
                  <small id={optionDescriptionId}>{option.description}</small>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {error ? (
        <p className="ot-field__error" id={errorId}>
          <span aria-hidden="true">!</span> {error}
        </p>
      ) : null}
    </fieldset>
  );
}
