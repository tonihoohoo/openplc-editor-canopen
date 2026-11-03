# Function block and function calls in Structured Text

This fork helps write calls in the Structured Text (ST) editor. None of it is CANopen specific, and
none of it changes the saved project, the compiler or the runtime. The code is in
`src/frontend/utils/st-calls/` (call builder, call parser, suggestions, hovers) and
`src/frontend/services/st-calls/` (the Monaco providers and "Insert call").

## The full call

A function block call is written one parameter per line, inputs and in-outs with `:=`, then
outputs with `=>`:

```
timer1(
    IN := TRUE,
    PT := T#100ms,
    Q => ,
    ET =>
);
```

Inputs of type `BOOL`, `TIME`, `INT`, `DINT`, `REAL` and `STRING` are prefilled with `TRUE`,
`T#100ms`, `0`, `0`, `0.0` and `''`; every other value is empty. Tab moves through the values in
order and then leaves the cursor after the call.

ST does not allow an empty value, so a call with one is marked as an error until the value is
filled in or the parameter is removed. The editor never removes a parameter by itself; see
[Remove empty parameters](#remove-empty-parameters).

A function call is an expression and is written on one line: `LIMIT(MN := , IN := , MX := )`.
An extensible standard function (`ADD`, `MUL`, `AND`, `OR`, `XOR`, `MAX`, `MIN`, `CONCAT`, `MUX`)
uses the unnamed form with its minimum inputs: `ADD(, )`, `MUX(, , )`.

## Inserting a call for an instance

- **Drag from the variable table.** In a POU's variable table, drag a row by its `#` cell into the
  ST body. A function block instance inserts its full call at the drop position; any other variable
  inserts its name. Nothing is declared and no dialog opens.
- **Insert call.** When the variables are shown as code, right-click the declaration line of an
  instance (`timer1 : TON;`) and pick **Insert call**. The call goes into the body at its cursor, or
  on a new line at its end when the body has not had the cursor yet. Other lines do not offer it.

## Call completion

The suggestion list offers calls next to the language server's own suggestions:

- After a name: `timer1 — all parameters` follows `timer1` for each function block instance in
  scope (the POU's variables and the globals), and `LIMIT — all parameters` once the full name of
  a library or project function is typed (a shorter prefix would double the long list of
  functions). The plain name stays first, so Enter on the first suggestion inserts only the
  name.
- Inside a call's parentheses (typing `(` or `,` opens the list):
  - `all parameters` (preselected in empty parentheses) or `all remaining` when some parameters are
    written, `inputs` and `outputs`;
  - each parameter not yet in the call, with its type and an `IN`, `OUT` or `IN/OUT` badge.
    In empty parentheses on one line the group items rewrite the line into the full call; otherwise
    they insert at the cursor, one per line in a call that already spans lines.
- A call without parameters: type `)` or `;`, or press Esc, and nothing is inserted.
- Extensible functions: after a comma in an unnamed call (`ADD(a, b, `) the list offers
  **next input** with the input's name and type (`IN3`, then `IN4`, ...); it keeps the empty value
  the comma started. A call already written with names (`ADD(IN1 := a, IN2 := b, `) is continued
  with names (`IN3 :=`). The two forms are never mixed in one call, as IEC 61131-3 requires. In
  an unnamed call of any other function, **next input** names the next declared input.
- Enter and Tab accept the selected item, as in the other suggestion lists.
- An instance whose function block is not in the project or in the visible libraries, and a name
  that is not a known function, get no call items.

Members of nested instances (`outer.inner(`), methods and Instruction List are not covered.

## Suggestion icons

Call items and groups use the function icon, since they write a call; single parameters use the
variable icon, the same one the language server shows for `timer1.IN`.

The language server's own suggestions (ST and Python) now show the icon of their kind: a variable
as a variable, a function as a function, a type as a type. Upstream passed the language server's
kind number to Monaco unchanged, and the two number the kinds in different orders, so a variable
showed as a structure and a function as a field.

## Remove empty parameters

On a call with parameters left without a value (`Q => ,`, or an empty unnamed value as in
`ADD(a, , c)`), the light bulb and Ctrl+. (Cmd+. on macOS) offer **Remove empty parameters**. It
removes every parameter of that call without a value, fixes the commas, keeps the other lines as
they are, and one undo brings them back.

## Library drop

Dragging a function block from the library into ST still asks for the instance name and declares
the instance, and now inserts the full call above, outputs included. Dragging a function inserts
its inputs as before.

## Documentation in ST

Hovering shows documentation below what the language server shows:

- a variable or instance: its Documentation from the variable table and, for an instance, the
  function block's description;
- a function or function block name: its description;
- a parameter name inside a call: its type and description, when the block has one. The bundled
  standard libraries describe their blocks but not their parameters, so this shows for project
  function blocks and libraries that describe parameters.

Nothing is added when there is no text. The suggestion list's details panel shows the same text
for the call, group and parameter items above.
