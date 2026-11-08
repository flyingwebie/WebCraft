# Translations are stored per Field, not per Entry

An Entry exists once. Each Field is either a Translatable field, holding one value per language, or shared by every language. Shared values such as prices, dates and Relationships cannot drift between languages, AI translation only touches Translatable fields, and a missing translation falls back to the default language one Field at a time.

## Considered Options

- **One linked copy of the Entry per language**: rejected because shared values would be duplicated and drift, and every structural change to an Entry would have to be repeated in each language.
