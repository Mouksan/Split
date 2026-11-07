// Split (бывший Swipeweaver) — сравнение двух свайпов одного сообщения.
// 1.0: окно сравнения, правка и сохранение, настройки шрифта.
// 1.1: просмотр свайпа как в чате (картинки и разметка), имя Split.
// Ключ настроек swipeweaver, префикс swv- и /swipecompare не меняются.

const MODULE_NAME = 'swipeweaver';
const LOG_PREFIX = '[Split]';
const COMMAND_NAME = 'swipecompare';

const BUTTON_CLASS = 'swv-open-btn';
const BUTTON_ICON = 'fa-table-columns';

// Код результата для кнопки «Сохранить всё и закрыть» в попапе.
const SAVE_ALL_RESULT = 1001;

// Все тексты интерфейса в одном месте.
const TEXTS = Object.freeze({
    buttonTitle: 'Сравнить свайпы',
    windowTitle: (mesId) => `Сравнение свайпов — сообщение #${mesId}`,
    swipeOption: (index, count) => `Свайп ${index + 1} из ${count}`,
    save: 'Сохранить',
    cancel: 'Отменить правки',
    saveAllAndClose: 'Сохранить всё и закрыть',
    close: 'Закрыть',
    hint: 'Ctrl+S — сохранить активную колонку, Esc — закрыть',
    locked: 'Идёт генерация — правка недоступна до её окончания',
    confirmClose: 'Правки не сохранены. Закрыть окно и потерять их?',
    confirmCloseOk: 'Закрыть',
    confirmCloseCancel: 'Вернуться',
    toastSaved: 'Свайп сохранён',
    toastSaveError: 'Не получилось сохранить свайп — подробности в консоли',
    toastOpenError: 'Не получилось открыть окно сравнения — подробности в консоли',
    toastOneSwipe: 'У этого сообщения всего один свайп — сравнивать не с чем',
    toastNoCharMessages: 'В этом чате нет сообщений персонажа',
    toastDirty: 'В этой колонке остались несохранённые правки',
    toastSameSwipe: 'Выбран один и тот же свайп',
    previewOn: 'Просмотр — как в чате',
    previewOff: 'Вернуться к тексту',
    toastForceClosed: 'Окно сравнения закрыто: сообщение или чат сменились',
    settingsFontSize: 'Размер шрифта в окне сравнения',
    settingsFontSizeInherit: 'Как в чате',
    settingsFontSizeOption: (px) => `${px} px`,
    settingsMonospace: 'Моноширинный шрифт',
});

// Варианты размера шрифта в настройках. 0 — «как в чате».
const FONT_SIZE_OPTIONS = [0, 12, 13, 14, 15, 16, 18, 20, 22];

const DEFAULT_SETTINGS = Object.freeze({
    fontSizePx: 0,      // 0 — как в чате
    monospace: false,
});

// Всё, что относится к открытому окну сравнения.
// Живёт только в памяти и целиком сбрасывается при смене чата,
// чтобы окно никогда не писало в сообщение из чужого чата.
const state = {
    isOpen: false,
    session: null,   // метка конкретного открытия окна
    chatId: null,
    mesId: null,
    message: null,   // сам объект сообщения — чтобы заметить, если его подменили
    popup: null,
    view: null,
};

/** Свежий контекст таверны. Берём каждый раз заново, а не кэшируем. */
function getCtx() {
    return SillyTavern.getContext();
}

function loadSettings() {
    const { extensionSettings } = getCtx();
    const settings = {
        ...DEFAULT_SETTINGS,
        ...(extensionSettings[MODULE_NAME] ?? {}),
    };
    // Старый ключ из первых этапов: там по умолчанию стояло 14, и оно могло сохраниться.
    // Выкидываем, чтобы по умолчанию шрифт был как в чате.
    delete settings.fontSize;
    extensionSettings[MODULE_NAME] = settings;
}

function getSettings() {
    return getCtx().extensionSettings[MODULE_NAME];
}

function resetState(reason) {
    state.isOpen = false;
    state.session = null;
    state.chatId = null;
    state.mesId = null;
    state.message = null;
    state.popup = null;
    state.view = null;
    console.log(`${LOG_PREFIX} Состояние сброшено: ${reason}`);
}

// ---------- Данные ----------

/** Индекс последнего видимого сообщения персонажа или -1, если таких нет. */
function getLastCharMessageId() {
    const { chat } = getCtx();
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message.is_user && !message.is_system) {
            return i;
        }
    }
    return -1;
}

/** Сколько свайпов у сообщения. Сообщение без массива swipes считается за один. */
function getSwipeCount(mesId) {
    const message = getCtx().chat[mesId];
    return Array.isArray(message?.swipes) ? message.swipes.length : 1;
}

/**
 * Можно ли вешать иконку на это сообщение.
 * Нет — твоим сообщениям и служебным (нарратор /sys, справка и т.п.:
 * у них таверна проставляет extra.type). Скрытые сообщения персонажа — да.
 */
function isComparableMessage(message) {
    return Boolean(message) && !message.is_user && !message.extra?.type;
}

/** Какой свайп сейчас показан в чате. */
function getActiveSwipeId(mesId) {
    const message = getCtx().chat[mesId];
    return Number.isInteger(message?.swipe_id) ? message.swipe_id : 0;
}

/** Сырой текст свайпа — ровно то, что таверна показывает в своём редакторе. */
function getSwipeText(mesId, index) {
    const message = getCtx().chat[mesId];
    if (Array.isArray(message?.swipes)) {
        return message.swipes[index] ?? '';
    }
    return message?.mes ?? '';
}

/** Идёт ли сейчас генерация — по кнопке «стоп» таверны. */
function isGenerationRunning() {
    const stopButton = document.getElementById('mes_stop');
    return Boolean(stopButton) && getComputedStyle(stopButton).display !== 'none';
}

/**
 * Записывает текст в свайп и сохраняет чат.
 * Трогаем только текст: swipes_info и extra (ризонинг, картинки) не меняются.
 * Активный свайп дополнительно обновляет mes и перерисовывается в чате —
 * тем же путём, что и штатное редактирование сообщения.
 */
async function saveSwipe(chatId, mesId, message, index, text) {
    const ctx = getCtx();

    // Защита от записи не туда: окно закрыто, чат сменился или сообщение подменили.
    if (!state.isOpen || ctx.chatId !== chatId || ctx.chat[mesId] !== message) {
        throw new Error('Окно устарело: чат или сообщение сменились');
    }

    const hasSwipes = Array.isArray(message.swipes);
    if (hasSwipes) {
        message.swipes[index] = text;
    }

    const isActive = !hasSwipes || getActiveSwipeId(mesId) === index;
    if (isActive) {
        message.mes = text;
        const updateMessageBlock = ctx.updateMessageBlock
            ?? (await import('/script.js')).updateMessageBlock;
        updateMessageBlock(mesId, message);
        await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_EDITED, mesId);
        await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_UPDATED, mesId);
    }

    await ctx.saveChat();
    console.log(`${LOG_PREFIX} Сохранён свайп ${index + 1} сообщения #${mesId}${isActive ? ' (активный)' : ''}`);
}

// ---------- Окно сравнения ----------

function createMenuButton(doc, text) {
    const button = doc.createElement('div');
    button.className = 'menu_button swv-btn disabled';
    button.textContent = text;
    button.tabIndex = 0;
    return button;
}

function fillSwipeOptions(doc, select, count) {
    const options = [];
    for (let i = 0; i < count; i++) {
        const option = doc.createElement('option');
        option.value = String(i);
        option.textContent = TEXTS.swipeOption(i, count);
        options.push(option);
    }
    select.replaceChildren(...options);
}

/**
 * Одна колонка: селектор свайпа, поле с текстом, кнопки сохранения.
 * doc передаётся явно — задел под вынос окна в отдельное окно браузера.
 */
function buildColumn(doc, side, mesId, initialCount, hooks) {
    let currentIndex = 0;
    let original = ''; // последний сохранённый текст — от него считаем «есть правки»
    let locked = false;

    const column = doc.createElement('div');
    column.className = 'swv-column';
    column.dataset.side = side;

    // Шапка: селектор + точка несохранённых правок.
    const header = doc.createElement('div');
    header.className = 'swv-column-header';

    const select = doc.createElement('select');
    select.className = 'swv-select';
    fillSwipeOptions(doc, select, initialCount);

    const dot = doc.createElement('span');
    dot.className = 'swv-dirty';
    dot.textContent = '•';

    // Глаз: «Просмотр» отрисовывает свайп как сообщение в чате, «Текст» — правка.
    const previewButton = doc.createElement('button');
    previewButton.type = 'button';
    previewButton.className = 'swv-preview-toggle menu_button';
    previewButton.title = TEXTS.previewOn;
    previewButton.setAttribute('aria-pressed', 'false');
    previewButton.innerHTML = '<i class="fa-solid fa-eye"></i>';

    header.append(select, previewButton, dot);

    const textarea = doc.createElement('textarea');
    textarea.className = 'swv-text text_pole';
    textarea.spellcheck = false;

    const { fontSizePx, monospace } = getSettings();
    if (fontSizePx > 0) {
        textarea.style.fontSize = `${fontSizePx}px`;
    }
    textarea.classList.toggle('swv-mono', Boolean(monospace));

    // Подвал: сохранить / отменить.
    const footer = doc.createElement('div');
    footer.className = 'swv-column-footer';
    const saveButton = createMenuButton(doc, TEXTS.save);
    const cancelButton = createMenuButton(doc, TEXTS.cancel);
    footer.append(saveButton, cancelButton);

    const preview = doc.createElement('div');
    preview.className = 'swv-preview mes_text';
    preview.hidden = true;
    if (fontSizePx > 0) {
        preview.style.fontSize = `${fontSizePx}px`;
    }

    column.append(header, textarea, preview, footer);

    let previewMode = false;

    // Тем же движком, что и сообщения в чате: маркдаун, регексы отображения, картинки.
    // Берём текст из поля — с несохранёнными правками, если они есть.
    const renderPreview = () => {
        const message = getCtx().chat?.[mesId];
        let html;
        try {
            const format = getCtx().messageFormatting;
            html = typeof format === 'function'
                ? format(textarea.value, message?.name ?? '', Boolean(message?.is_system), Boolean(message?.is_user), mesId)
                : null;
        } catch (error) {
            console.warn(`${LOG_PREFIX} Не смог отрисовать просмотр`, error);
            html = null;
        }
        if (html === null || html === undefined) {
            preview.textContent = textarea.value;
            preview.classList.add('swv-preview-plain');
        } else {
            preview.innerHTML = html;
            preview.classList.remove('swv-preview-plain');
        }
        preview.scrollTop = 0;
    };

    const setPreview = (on) => {
        previewMode = on;
        previewButton.setAttribute('aria-pressed', String(on));
        previewButton.classList.toggle('swv-active', on);
        previewButton.title = on ? TEXTS.previewOff : TEXTS.previewOn;
        previewButton.innerHTML = on ? '<i class="fa-solid fa-pen"></i>' : '<i class="fa-solid fa-eye"></i>';
        textarea.hidden = on;
        preview.hidden = !on;
        if (on) renderPreview();
    };

    previewButton.addEventListener('click', () => setPreview(!previewMode));

    const isDirty = () => textarea.value !== original;

    const refreshControls = () => {
        const dirty = isDirty();
        dot.classList.toggle('swv-visible', dirty);
        saveButton.classList.toggle('disabled', locked || !dirty);
        cancelButton.classList.toggle('disabled', locked || !dirty);
    };

    const show = (index) => {
        currentIndex = index;
        select.value = String(index);
        original = getSwipeText(mesId, index);
        textarea.value = original;
        textarea.scrollTop = 0;
        refreshControls();
        if (previewMode) renderPreview();
    };

    /** Сохраняет колонку. Бросает ошибку, если не вышло. */
    const save = async () => {
        if (locked || !isDirty()) {
            return false;
        }
        const text = textarea.value;
        await hooks.saveSwipe(currentIndex, text);
        original = text;
        refreshControls();
        hooks.onSaved(side, currentIndex);
        return true;
    };

    /** То же, но с тостами — для кнопки и Ctrl+S. */
    const saveWithToast = async () => {
        try {
            if (await save()) {
                toastr.success(TEXTS.toastSaved);
            }
        } catch (error) {
            console.error(`${LOG_PREFIX} Не смог сохранить свайп`, error);
            toastr.error(TEXTS.toastSaveError);
        }
    };

    // Перечитать текст из чата, если в колонке нет своих правок.
    const reloadIfClean = () => {
        if (!isDirty()) {
            show(currentIndex);
        }
    };

    const setLocked = (value) => {
        locked = value;
        textarea.readOnly = value;
        select.disabled = value;
        refreshControls();
    };

    // Число свайпов выросло (догенерился новый) — обновляем список, текст не трогаем.
    const updateCount = (count) => {
        fillSwipeOptions(doc, select, count);
        select.value = String(currentIndex);
    };

    select.addEventListener('change', () => {
        const next = Number(select.value);

        // Не даём потерять правки переключением свайпа.
        if (isDirty()) {
            select.value = String(currentIndex);
            toastr.warning(TEXTS.toastDirty);
            return;
        }

        show(next);
        hooks.onSwitched();
    });

    textarea.addEventListener('input', refreshControls);
    column.addEventListener('focusin', () => hooks.onFocus(side));

    saveButton.addEventListener('click', () => {
        if (!saveButton.classList.contains('disabled')) {
            saveWithToast();
        }
    });

    cancelButton.addEventListener('click', () => {
        if (cancelButton.classList.contains('disabled')) {
            return;
        }
        textarea.value = original;
        refreshControls();
        if (previewMode) renderPreview();
    });

    return {
        column,
        show,
        save,
        saveWithToast,
        isDirty,
        reloadIfClean,
        setLocked,
        updateCount,
        getIndex: () => currentIndex,
    };
}

/** Собирает всё окно. Возвращает корень и управление им. */
function buildWindow(doc, chatId, mesId, message) {
    let count = getSwipeCount(mesId);
    const active = getActiveSwipeId(mesId);
    let locked = false;
    let forced = false;
    let lastFocusedSide = null;

    const root = doc.createElement('div');
    root.className = 'swv-window';

    const title = doc.createElement('h3');
    title.className = 'swv-title';
    title.textContent = TEXTS.windowTitle(mesId);

    const columns = doc.createElement('div');
    columns.className = 'swv-columns';

    const divider = doc.createElement('div');
    divider.className = 'swv-divider';

    const hint = doc.createElement('div');
    hint.className = 'swv-hint';
    hint.textContent = TEXTS.hint;

    const hooks = {
        saveSwipe: (index, text) => saveSwipe(chatId, mesId, message, index, text),

        // Если сохранили свайп, который открыт и в соседней колонке, — обновляем соседа
        // (если у него самого нет правок).
        onSaved: (side, index) => {
            const other = side === 'left' ? right : left;
            if (other.getIndex() === index) {
                other.reloadIfClean();
            }
        },

        onSwitched: () => {
            if (left.getIndex() === right.getIndex()) {
                toastr.warning(TEXTS.toastSameSwipe);
            }
        },

        onFocus: (side) => {
            lastFocusedSide = side;
        },
    };

    const left = buildColumn(doc, 'left', mesId, count, hooks);
    const right = buildColumn(doc, 'right', mesId, count, hooks);

    columns.append(left.column, divider, right.column);
    root.append(title, columns, hint);

    // Слева — то, что сейчас в чате, справа — следующий по кругу.
    left.show(active);
    right.show((active + 1) % count);

    // Ctrl+S (и Cmd+S на маке) — сохранить колонку, в которой последней был курсор.
    // e.code, а не e.key, — чтобы работало и на русской раскладке.
    root.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS') {
            event.preventDefault();
            event.stopPropagation();
            if (locked || !lastFocusedSide) {
                return;
            }
            (lastFocusedSide === 'left' ? left : right).saveWithToast();
        }
    });

    return {
        root,
        left,
        right,
        getCount: () => count,
        isLocked: () => locked,
        isForced: () => forced,
        markForced: () => { forced = true; },
        isDirty: () => left.isDirty() || right.isDirty(),

        setLocked: (value) => {
            locked = value;
            left.setLocked(value);
            right.setLocked(value);
            hint.textContent = value ? TEXTS.locked : TEXTS.hint;
            hint.classList.toggle('swv-hint-locked', value);
        },

        setCount: (value) => {
            count = value;
            left.updateCount(value);
            right.updateCount(value);
        },
    };
}

/** «Сохранить всё и закрыть»: сохраняет колонки с правками, левую первой. */
async function saveAll(view) {
    let saved = 0;
    try {
        for (const column of [view.left, view.right]) {
            if (await column.save()) {
                saved++;
            }
        }
        if (saved > 0) {
            toastr.success(TEXTS.toastSaved);
        }
        return true;
    } catch (error) {
        console.error(`${LOG_PREFIX} Не смог сохранить свайп`, error);
        toastr.error(TEXTS.toastSaveError);
        return false; // окно остаётся открытым, правки не теряются
    }
}

/**
 * Вызывается попапом перед закрытием. false — окно остаётся открытым.
 * Сюда приходят и «Закрыть», и Esc, и «Сохранить всё и закрыть».
 */
async function onPopupClosing(popup, view) {
    if (view.isForced()) {
        return true;
    }

    if (Number(popup.result) === SAVE_ALL_RESULT) {
        if (view.isLocked()) {
            toastr.warning(TEXTS.locked);
            return false;
        }
        return saveAll(view);
    }

    if (!view.isDirty()) {
        return true;
    }

    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = getCtx();
    const answer = await callGenericPopup(TEXTS.confirmClose, POPUP_TYPE.CONFIRM, '', {
        okButton: TEXTS.confirmCloseOk,
        cancelButton: TEXTS.confirmCloseCancel,
    });
    return answer === (POPUP_RESULT?.AFFIRMATIVE ?? 1);
}

/** Закрыть окно без вопросов — когда писать уже некуда. */
async function forceClose() {
    const { popup, view } = state;
    if (!popup || !view || view.isForced()) {
        return;
    }

    view.markForced();
    toastr.info(TEXTS.toastForceClosed);

    try {
        await popup.complete(getCtx().POPUP_RESULT?.CANCELLED ?? null);
    } catch (error) {
        console.error(`${LOG_PREFIX} Не смог закрыть окно`, error);
    }
}

/**
 * Сверяет открытое окно с чатом после любого события, которое могло его поменять.
 * Сообщение подменили или удалили, свайпов стало меньше — закрываем.
 * Свайпов стало больше — обновляем селекторы.
 */
function syncWithChat() {
    const { view } = state;
    if (!state.isOpen || !view) {
        return;
    }

    const { chat, chatId } = getCtx();
    if (chatId !== state.chatId || chat[state.mesId] !== state.message) {
        forceClose();
        return;
    }

    const count = getSwipeCount(state.mesId);
    if (count < view.getCount()) {
        forceClose();
    } else if (count > view.getCount()) {
        view.setCount(count);
    }
}

/** Сюда ведут и иконка, и слэш-команда. */
async function openCompare(mesId) {
    if (state.isOpen) {
        return;
    }

    if (getSwipeCount(mesId) < 2) {
        toastr.info(TEXTS.toastOneSwipe);
        return;
    }

    const ctx = getCtx();
    const session = Symbol('swv-session');
    const message = ctx.chat[mesId];

    state.isOpen = true;
    state.session = session;
    state.chatId = ctx.chatId;
    state.mesId = mesId;
    state.message = message;

    try {
        const view = buildWindow(document, ctx.chatId, mesId, message);
        state.view = view;
        view.setLocked(isGenerationRunning());

        const PopupClass = ctx.Popup ?? (await import('/scripts/popup.js')).Popup;
        const popup = new PopupClass(view.root, ctx.POPUP_TYPE.TEXT, '', {
            wide: true,
            large: true,
            okButton: TEXTS.close,
            allowVerticalScrolling: false,
            customButtons: [{ text: TEXTS.saveAllAndClose, result: SAVE_ALL_RESULT }],
            onClosing: (p) => onPopupClosing(p, view),
        });
        state.popup = popup;

        await popup.show();
    } catch (error) {
        console.error(`${LOG_PREFIX} Не смог открыть окно`, error);
        toastr.error(TEXTS.toastOpenError);
    } finally {
        // Сбрасываем, только если состояние всё ещё наше, а не нового окна.
        if (state.session === session) {
            resetState('окно закрыто');
        }
    }
}

// ---------- Настройки ----------

/** Блок настроек в панели расширений (стандартная раскрывашка таверны). */
function renderSettingsPanel() {
    const container = document.getElementById('extensions_settings2')
        ?? document.getElementById('extensions_settings');
    if (!container) {
        console.warn(`${LOG_PREFIX} Не нашёл панель расширений — настройки не показаны`);
        return;
    }

    const settings = getSettings();

    const fontOptions = FONT_SIZE_OPTIONS.map((px) => {
        const label = px === 0 ? TEXTS.settingsFontSizeInherit : TEXTS.settingsFontSizeOption(px);
        return `<option value="${px}">${label}</option>`;
    }).join('');

    const html = `
        <div class="swv-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-table-columns"></i> 「 SPLIT 」</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="swv-settings-body">
                    <label for="swv-font-size">${TEXTS.settingsFontSize}</label>
                    <select id="swv-font-size" class="text_pole">${fontOptions}</select>
                    <label class="checkbox_label" for="swv-monospace">
                        <input type="checkbox" id="swv-monospace">
                        <span>${TEXTS.settingsMonospace}</span>
                    </label>
                    </div>
                </div>
            </div>
        </div>`;

    container.insertAdjacentHTML('beforeend', html);

    const fontSelect = document.getElementById('swv-font-size');
    const monoCheckbox = document.getElementById('swv-monospace');

    // Если сохранено значение, которого нет в списке, — показываем «как в чате».
    fontSelect.value = FONT_SIZE_OPTIONS.includes(settings.fontSizePx) ? String(settings.fontSizePx) : '0';
    monoCheckbox.checked = Boolean(settings.monospace);

    fontSelect.addEventListener('change', () => {
        getSettings().fontSizePx = Number(fontSelect.value);
        getCtx().saveSettingsDebounced();
    });

    monoCheckbox.addEventListener('change', () => {
        getSettings().monospace = monoCheckbox.checked;
        getCtx().saveSettingsDebounced();
    });
}

// ---------- Иконка на сообщениях ----------

function createButton() {
    const button = document.createElement('div');
    button.className = `mes_button ${BUTTON_CLASS} fa-solid ${BUTTON_ICON} interactable`;
    button.title = TEXTS.buttonTitle;
    button.tabIndex = 0;
    return button;
}

/**
 * Проходит по всем сообщениям в чате и добавляет иконку туда, где её ещё нет.
 * Безопасно вызывать сколько угодно раз — дублей не будет.
 */
function injectButtons() {
    const { chat } = getCtx();

    document.querySelectorAll('#chat .mes').forEach((mesElement) => {
        if (mesElement.querySelector(`.${BUTTON_CLASS}`)) {
            return;
        }

        const mesId = Number(mesElement.getAttribute('mesid'));
        if (!isComparableMessage(chat[mesId])) {
            return;
        }

        // Общий контейнер для кнопок расширений: в ванили — меню под «…»,
        // в телеграм-теме — сетка «More». Если его вдруг нет — ряд кнопок сообщения.
        const container = mesElement.querySelector('.extraMesButtons')
            ?? mesElement.querySelector('.mes_buttons');

        if (!container) {
            return;
        }

        container.append(createButton());
    });
}

let injectScheduled = false;

/** Доставить иконки на ближайшем кадре — несколько вызовов подряд схлопываются в один. */
function scheduleInjectButtons() {
    if (injectScheduled) {
        return;
    }
    injectScheduled = true;
    requestAnimationFrame(() => {
        injectScheduled = false;
        injectButtons();
    });
}

/**
 * Страховка: следим за появлением новых блоков сообщений в ленте чата.
 * Смотрим только на добавление целых сообщений, а не на изменение текста при стриминге.
 */
function observeChat() {
    const chatElement = document.getElementById('chat');
    if (!chatElement) {
        console.warn(`${LOG_PREFIX} Не нашёл ленту чата — наблюдатель не запущен`);
        return;
    }

    const observer = new MutationObserver((mutations) => {
        const hasNewMessage = mutations.some((mutation) => [...mutation.addedNodes]
            .some((node) => node.nodeType === Node.ELEMENT_NODE && node.classList.contains('mes')));
        if (hasNewMessage) {
            scheduleInjectButtons();
        }
    });

    observer.observe(chatElement, { childList: true });
}

function onButtonClick(event) {
    const mesElement = event.currentTarget.closest('.mes');
    const mesId = Number(mesElement?.getAttribute('mesid'));

    if (!Number.isInteger(mesId)) {
        console.warn(`${LOG_PREFIX} Не понял, по какому сообщению клик`);
        return;
    }

    openCompare(mesId);
}

// ---------- Слэш-команда ----------

function onSwipeCompareCommand() {
    const mesId = getLastCharMessageId();

    if (mesId === -1) {
        toastr.warning(TEXTS.toastNoCharMessages);
        return '';
    }

    openCompare(mesId);
    return '';
}

function registerSlashCommand() {
    const { SlashCommandParser, SlashCommand } = getCtx();

    if (!SlashCommandParser || !SlashCommand) {
        console.warn(`${LOG_PREFIX} Не нашёл парсер слэш-команд — таверна слишком старая?`);
        return;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: COMMAND_NAME,
        callback: onSwipeCompareCommand,
        helpString: 'Открыть сравнение свайпов для последнего сообщения персонажа.',
    }));
}

// ---------- События ----------

function onIfExists(eventSource, eventName, handler) {
    if (eventName) {
        eventSource.on(eventName, handler);
    }
}

function bindEvents() {
    const { eventSource, eventTypes } = getCtx();

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        if (state.isOpen) {
            forceClose();
        }
        resetState('смена чата');
        injectButtons();
    });

    // Иконки на новых и подгруженных сообщениях. Остановка генерации руками
    // не присылает «сообщение отрисовано», поэтому ловим и её, и соседние события.
    for (const eventName of [
        eventTypes.CHARACTER_MESSAGE_RENDERED,
        eventTypes.MORE_MESSAGES_LOADED,
        eventTypes.MESSAGE_RECEIVED,
        eventTypes.MESSAGE_SWIPED,
        eventTypes.GENERATION_ENDED,
        eventTypes.GENERATION_STOPPED,
    ]) {
        onIfExists(eventSource, eventName, scheduleInjectButtons);
    }

    // Генерация: блокируем правку. Фоновые «тихие» генерации (комменты, промпты картинок)
    // и пробные прогоны для подсчёта токенов чат не трогают — на них не реагируем.
    eventSource.on(eventTypes.GENERATION_STARTED, (type, _params, dryRun) => {
        if (dryRun || type === 'quiet') {
            return;
        }
        state.view?.setLocked(true);
    });

    const unlockAndSync = () => {
        state.view?.setLocked(false);
        syncWithChat();
    };
    onIfExists(eventSource, eventTypes.GENERATION_ENDED, unlockAndSync);
    onIfExists(eventSource, eventTypes.GENERATION_STOPPED, unlockAndSync);

    // Всё, что может поменять сообщение под окном.
    onIfExists(eventSource, eventTypes.MESSAGE_RECEIVED, syncWithChat);
    onIfExists(eventSource, eventTypes.MESSAGE_SWIPED, syncWithChat);
    onIfExists(eventSource, eventTypes.MESSAGE_DELETED, syncWithChat);
    onIfExists(eventSource, eventTypes.MESSAGE_SWIPE_DELETED, syncWithChat);

    // Один делегированный обработчик на весь чат — не вешаем по штуке на каждую иконку.
    $(document).on('click', `.${BUTTON_CLASS}`, onButtonClick);
}

jQuery(() => {
    loadSettings();
    renderSettingsPanel();
    registerSlashCommand();
    bindEvents();
    observeChat();
    injectButtons(); // на случай, если чат уже отрисован к моменту загрузки
    console.log(`${LOG_PREFIX} Загружен, версия 1.0`);
});
