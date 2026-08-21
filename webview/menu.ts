/**
 * The hand-drawn context menu, shared by both frames.
 *
 * It lived in the sidebar, which was the only frame with a filter button. The
 * panel's history screen now has the same two buttons, and a second menu
 * implementation would be a second set of metrics, a second keyboard model and
 * a second thing to get wrong - so the widget moved here whole and neither
 * frame owns it.
 *
 * Everything below the fold of this comment is unchanged from where it was
 * written; the notes on WHY it is drawn rather than contributed, and on which
 * workbench metrics it copies, are kept with the code they explain.
 */

import { el, icon } from './dom';

/**
 * A context menu with submenus, drawn by hand.
 *
 * Drawn rather than contributed because of one hard constraint: a contributed
 * menu is declared in package.json and there is no API to add an item at
 * runtime. Tags are the user's own data, discovered by reading their library,
 * so a native menu can never list them. The other options are worse still - a
 * select is a browser widget that looks nothing like the editor, and a row of
 * chips that unfolds shoves every template down as you reach for one.
 *
 * So this matches the workbench menu instead: the same colour tokens, 22px
 * rows, a leading check column, separators, and submenus that open to the side
 * on hover or on Right.
 *
 * Levels form a stack. Opening one at depth N closes everything below it, so
 * the structure can never fork.
 */
export interface MenuItem {
  readonly label: string;
  /**
   * `radio` closes the whole menu on pick - one choice, made.
   * `checkbox` leaves it open, because you toggle several.
   * `submenu` opens `items` beside itself.
   */
  readonly kind: 'radio' | 'checkbox' | 'action' | 'submenu';
  readonly checked?: boolean;
  readonly title?: string;
  readonly separatorBefore?: boolean;
  /** Greyed and unusable - an empty section says so rather than vanishing. */
  readonly disabled?: boolean;
  readonly items?: readonly MenuItem[];
  run?(): void;
}

interface MenuLevel {
  readonly node: HTMLElement;
  readonly buttons: HTMLElement[];
  /** The submenu item this level hangs off, for Left and for focus return. */
  readonly parent?: HTMLElement;
}

const ROLES: Readonly<Record<MenuItem['kind'], string>> = {
  radio: 'menuitemradio',
  checkbox: 'menuitemcheckbox',
  action: 'menuitem',
  submenu: 'menuitem',
};

/** How long the pointer must rest on a row before its submenu opens. */
const SUBMENU_DELAY = 180;

let levels: MenuLevel[] = [];
let menuListeners: (() => void) | undefined;
let submenuTimer: ReturnType<typeof setTimeout> | undefined;

/** True while any menu is up - the row list checks this before taking a key. */
export function menuIsOpen(): boolean {
  return levels.length > 0;
}

/** Drop levels deeper than `depth`, innermost first. */
function closeToDepth(depth: number): void {
  while (levels.length > depth) {
    const level = levels.pop();
    level?.node.remove();
    level?.parent?.setAttribute('aria-expanded', 'false');
  }
}

export function closeMenu(restoreFocusTo?: HTMLElement): void {
  if (submenuTimer) clearTimeout(submenuTimer);
  submenuTimer = undefined;
  closeToDepth(0);
  menuListeners?.();
  menuListeners = undefined;
  restoreFocusTo?.focus();
}

/** Flip a menu item's tick, keeping the reserved check column either way. */
function setChecked(button: HTMLElement, on: boolean): void {
  button.setAttribute('aria-checked', String(on));
  button.firstElementChild?.replaceWith(
    on ? icon('check', 'stk-menu-check') : el('span', { class: 'stk-menu-check' }),
  );
}

/** Which level the keyboard is in, or -1 when focus has left the menu. */
function focusedDepth(): number {
  return levels.findIndex((level) => level.node.contains(document.activeElement));
}

function buildLevel(label: string, items: readonly MenuItem[], depth: number): MenuLevel {
  const node = el('div', { class: 'stk-menu', role: 'menu', 'aria-label': label });
  const buttons: HTMLElement[] = [];

  for (const item of items) {
    if (item.separatorBefore) node.append(el('div', { class: 'stk-menu-sep', role: 'separator' }));
    const button = el(
      'button',
      {
        class: 'stk-menu-item' + (item.disabled ? ' stk-menu-disabled' : ''),
        type: 'button',
        role: ROLES[item.kind],
        tabindex: -1,
        ...(item.disabled ? { 'aria-disabled': true } : {}),
        ...(item.kind === 'radio' || item.kind === 'checkbox'
          ? { 'aria-checked': item.checked === true }
          : {}),
        ...(item.kind === 'submenu' ? { 'aria-haspopup': 'menu', 'aria-expanded': false } : {}),
        ...(item.title ? { title: item.title } : {}),
      },
      [
        // The check column is always there, ticked or not, so labels line up -
        // the same reason a leaf tree row still reserves its twistie. A
        // submenu parent can carry a tick too: it says the current choice is
        // somewhere inside, which is what saves you opening all three.
        item.checked ? icon('check', 'stk-menu-check') : el('span', { class: 'stk-menu-check' }),
        el('span', { class: 'stk-menu-label', text: item.label }),
        ...(item.kind === 'submenu' ? [icon('chevron-right', 'stk-menu-more')] : []),
      ],
    );

    if (!item.disabled) {
      button.addEventListener('click', () => {
        if (item.kind === 'submenu') {
          openSubmenu(button, item, depth);
          levels[depth + 1]?.buttons[0]?.focus();
          return;
        }
        // A checkbox leaves the menu up: ticking three tags should not mean
        // opening the menu three times. Its own tick has to be updated here,
        // since nothing else is going to rebuild it.
        if (item.kind === 'checkbox') {
          setChecked(button, button.getAttribute('aria-checked') !== 'true');
          item.run?.();
          return;
        }
        closeMenu();
        item.run?.();
      });

      // Pointer behaviour is the workbench's: moving along the rows opens the
      // submenu you rest on and closes the one you left, after a beat so that
      // crossing a row on the way somewhere else does not flash a menu open.
      button.addEventListener('mouseenter', () => {
        // Focus follows the pointer, which is what keeps the menu to ONE lit
        // row. A menu opens with the ticked item focused; without this, resting
        // the pointer anywhere else lit that row as well and the menu appeared
        // to have two cursors. It also means the keyboard picks up wherever
        // the mouse left off, rather than back where it started.
        button.focus();
        if (submenuTimer) clearTimeout(submenuTimer);
        submenuTimer = setTimeout(() => {
          if (item.kind === 'submenu') openSubmenu(button, item, depth);
          else closeToDepth(depth + 1);
        }, SUBMENU_DELAY);
      });
    }

    buttons.push(button);
    node.append(button);
  }

  return { node, buttons };
}

function openSubmenu(parent: HTMLElement, item: MenuItem, depth: number): void {
  // Already showing this one: leave it, or hovering along its own rows would
  // rebuild it under the pointer.
  if (levels[depth + 1]?.parent === parent) return;
  closeToDepth(depth + 1);
  const level = buildLevel(item.label, item.items ?? [], depth + 1);
  document.body.append(level.node);
  placeBeside(level.node, parent);
  parent.setAttribute('aria-expanded', 'true');
  levels.push({ ...level, parent });
}

export function showMenu(anchor: HTMLElement, label: string, items: readonly MenuItem[]): void {
  closeMenu();

  const root = buildLevel(label, items, 0);
  document.body.append(root.node);
  placeUnder(root.node, anchor);
  levels.push(root);

  const onPointerDown = (event: Event): void => {
    const target = event.target as globalThis.Node | null;
    if (!target) return;
    if (anchor.contains(target)) return;
    if (levels.some((open) => open.node.contains(target))) return;
    closeMenu();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const depth = focusedDepth();
    if (depth < 0) return;
    const level = levels[depth]!;
    const usable = level.buttons.filter((button) => button.getAttribute('aria-disabled') !== 'true');
    const stop = (): void => {
      event.preventDefault();
      // Capture phase, so stopping here is what keeps the row list from also
      // acting on the key. Both listeners are on `document`.
      event.stopPropagation();
    };

    switch (event.key) {
      case 'Escape':
      case 'Tab': {
        // Escape peels one level at a time, the way a nested menu should.
        const parent = level.parent;
        if (depth > 0) {
          closeToDepth(depth);
          parent?.focus();
        } else {
          closeMenu(anchor);
        }
        stop();
        return;
      }

      case 'ArrowDown':
      case 'ArrowUp': {
        if (usable.length === 0) return stop();
        const current = usable.findIndex((button) => button === document.activeElement);
        // Wrapping, which a menu does and a list does not: there is no "past
        // the end" in a menu, and a keyboard user should not have to reverse.
        const next =
          event.key === 'ArrowDown'
            ? (current + 1) % usable.length
            : (current <= 0 ? usable.length : current) - 1;
        usable[next]?.focus();
        stop();
        return;
      }

      case 'ArrowRight': {
        const focused = document.activeElement as HTMLElement | null;
        if (focused?.getAttribute('aria-haspopup') === 'menu') focused.click();
        stop();
        return;
      }

      case 'ArrowLeft': {
        if (depth === 0) return;
        const parent = level.parent;
        closeToDepth(depth);
        parent?.focus();
        stop();
        return;
      }

      default:
        return;
    }
  };

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  menuListeners = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
  };

  // Open on the ticked row, so the menu starts where you already are.
  const ticked = root.buttons.find((button) => button.getAttribute('aria-checked') === 'true');
  (ticked ?? root.buttons[0])?.focus();
}

/**
 * Put a root menu under its button, flipping and clamping to stay on screen.
 *
 * Right-aligned because the buttons sit at the right edge of a narrow pane; a
 * left-aligned menu would hang off it. The sidebar can be dragged very narrow,
 * so the width is capped rather than assumed.
 */
function placeUnder(node: HTMLElement, anchor: HTMLElement): void {
  const box = anchor.getBoundingClientRect();
  const below = box.bottom + 2;
  const top =
    below + node.offsetHeight < window.innerHeight
      ? below
      : Math.max(4, box.top - node.offsetHeight - 2);
  node.style.top = top + 'px';
  node.style.left = clampLeft(box.right - node.offsetWidth, node.offsetWidth) + 'px';
}

/**
 * Put a submenu beside the row it belongs to.
 *
 * To the right normally, and to the LEFT when there is no room - which in a
 * sidebar at its usual width is most of the time, so the flip is the common
 * path rather than an edge case. It overlaps the parent by two pixels on
 * purpose: that leaves no gap for the pointer to fall through on the way
 * across, which would close the very menu you are reaching for.
 */
function placeBeside(node: HTMLElement, parent: HTMLElement): void {
  const box = parent.getBoundingClientRect();
  const width = node.offsetWidth;
  const right = box.right - 2;
  const left = right + width < window.innerWidth ? right : box.left - width + 2;
  node.style.left = clampLeft(left, width) + 'px';
  // Aligned to the row, then pulled up by the menu's own padding so the first
  // item sits level with the row it came from.
  const top = box.top - 4;
  node.style.top = Math.max(4, Math.min(top, window.innerHeight - node.offsetHeight - 4)) + 'px';
}

function clampLeft(left: number, width: number): number {
  return Math.max(4, Math.min(left, window.innerWidth - width - 4));
}
