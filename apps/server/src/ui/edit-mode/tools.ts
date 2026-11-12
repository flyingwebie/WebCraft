// Edit mode's own tools, in one module the editing bar loads (`site/edit-bar/assets.ts`): each part
// hands itself to the bar in an event of its own. The Command menu comes first, so it hears the Page
// layout's controller however fast that is made.
import "./command-menu.tsx";
import "../page-layouts/edit-mode.tsx";
