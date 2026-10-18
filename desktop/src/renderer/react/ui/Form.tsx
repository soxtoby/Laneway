import { Button, type ButtonProps } from "react-aria-components/Button"
import { FieldError as RACFieldError, type FieldErrorProps } from "react-aria-components/FieldError"
import { Form as RACForm, type FormProps } from "react-aria-components/Form"
import { Label as RACLabel, type LabelProps } from "react-aria-components/Label"
import { type TextProps } from "react-aria-components/Text"
import "./Form.css"
import { Text } from "./Content"

export function Form(props: FormProps) {
    return <RACForm {...props} />
}

export function Label(props: LabelProps) {
    return <RACLabel {...props} />
}

export function FieldError(props: FieldErrorProps) {
    return <RACFieldError {...props} />
}

export function Description(props: TextProps) {
    return <Text slot="description" className="field-description" {...props} />
}

export function FieldButton(props: ButtonProps) {
    return <Button {...props} className="field-Button" />
}
