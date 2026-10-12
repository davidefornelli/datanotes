# Naming

The project is called **Datanotes**: notes that are data. Decided in October 2026, after a first
release as *Datanote*.

## Criteria

1. **Short and pronounceable** the same way in English and Italian, spelt the way it sounds.
2. **Describes what it does**: Markdown notes run as typed, validated database tables, readable and
   writable by AI agents. It promises no more than that (no "OS").
3. **Unambiguous**: no product with the same name in the same category (notes, knowledge,
   AI memory).
4. **Available everywhere in the same form**: npm, PyPI, GitHub, a domain.

## Checks (7 October 2026)

| Where | `datanotes` |
| --- | --- |
| npm | free |
| PyPI | free |
| Domains | `.dev`, `.io` and `.app` free; `.com` registered since 2002, parked |
| GitHub | 23 repositories with the name, all personal notes or small tools (at most 1 star) |
| Same name in use | no product; *DataNote ERP* (India) and *Datan* (decision journal) are close names in other categories |

## History

The first public release (npm `datanote` 1.0.0, domain `datanote.dev`) used the singular. It was
renamed to the plural before any other user depended on it. `datanote` 1.0.0 was then removed from
npm, which left the name free for anyone. To keep it, `scripts/placeholder-datanote/` holds an
empty package `datanote` 1.0.1 that says "Renamed: use datanotes". The owner publishes it by hand,
then deprecates it with that message.

Names set aside: *NoteOS* (an AI notes and tasks app already uses it, and "OS" overpromises),
*NotesOS* (refused by npm next to the existing `notes-os` package), *Datanote* (the first name).

## Trademark (checked 12 October 2026)

"Datanotes" is the name of this open-source project (npm package `datanotes`, site datanotes.dev).
It is not a registered trademark, and the project claims no exclusive rights in the words "data" or
"notes". Datanotes is not affiliated with, endorsed by or connected to DataNote ERP (Safal Infosoft
Pvt. Ltd.), the DataNotes app by Data Ingenious Global Ltd, or any other product with a similar
name. You may use the name to refer to this project. Forks and derivative works must use a different
name and must not suggest they are the official project. If you hold rights in a similar mark and
have a concern, open an issue or contact the maintainer.

What the check found, from public and secondary sources (not legal advice):

- **India**: DATANOTE, a figurative mark of Safal Infosoft (no. 3807557), registered in class 9 for
  ERP software and mobile apps, in use. A second filing of theirs (no. 6719245) is pending.
- **United States**: no mark DATANOTES or DATANOTE.
- **EU, WIPO and UK**: no record found, but the official databases could not be queried
  automatically.

Before registering the trademark, search TMview (EU and Italy), WIPO, USPTO, UK IPO and IP India
by hand in classes 9 and 42, ideally with a professional clearance search.
