// Галерея иконок проектов: линейные SVG 24×24, обводка цветом текста.
// id хранится в _board.json (icons[файл] = { icon, color }); набор только расширяем — id не переименовываем.
const I = (id, title, body) => ({ id, title, body });

export const PROJECT_ICONS = [
  I('folder', 'Папка', '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>'),
  I('briefcase', 'Работа', '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M3 12.5h18"/>'),
  I('home', 'Дом', '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>'),
  I('building', 'Офис', '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M11 21v-3h2v3"/>'),
  I('users', 'Команда', '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.3c2.2.7 3.5 2.8 3.5 5.7"/>'),
  I('user', 'Личное', '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>'),
  I('star', 'Звезда', '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>'),
  I('heart', 'Сердце', '<path d="M12 20s-7.5-4.5-9-9.3C2 7.4 4.2 4.5 7.3 4.5c2 0 3.6 1.1 4.7 2.8 1.1-1.7 2.7-2.8 4.7-2.8 3.1 0 5.3 2.9 4.3 6.2C19.5 15.5 12 20 12 20z"/>'),
  I('target', 'Цель', '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>'),
  I('flag', 'Флаг', '<path d="M5.5 21V4"/><path d="M5.5 4.5h12l-2.5 4 2.5 4h-12"/>'),
  I('rocket', 'Запуск', '<path d="M9.5 15 7 12.5C8.5 7.5 12 4 19.5 4.5 20 12 16.5 15.5 11.5 17z"/><circle cx="15" cy="9" r="1.6"/><path d="M7 12.5 4 13l2-4h4M11.5 17 11 20l4-2v-4M6.5 16.5c-1.5.5-2.5 2-2.5 3.5 1.5 0 3-1 3.5-2.5"/>'),
  I('bolt', 'Энергия', '<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/>'),
  I('chart', 'Аналитика', '<path d="M3 20.5h18"/><path d="M6 20.5v-7M11 20.5V5M16 20.5v-10"/><path d="M20 20.5V8"/>'),
  I('pulse', 'Здоровье', '<path d="M3 12h4l2.5-5 4 10 2.5-5H21"/>'),
  I('calendar', 'Календарь', '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  I('clipboard', 'Чек-лист', '<rect x="5" y="4.5" width="14" height="16.5" rx="2"/><path d="M9 4.5V3h6v1.5"/><path d="m9 13 2 2 4-4"/>'),
  I('doc', 'Документ', '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h7M9 17h7"/>'),
  I('book', 'Книга', '<path d="M4 18.5V5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2 2 2 0 0 0 2 2h13"/>'),
  I('graduation', 'Учёба', '<path d="m2 9.5 10-5 10 5-10 5z"/><path d="M6 11.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5M22 9.5v6"/>'),
  I('bulb', 'Идеи', '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z"/>'),
  I('code', 'Разработка', '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>'),
  I('bug', 'Баги', '<rect x="7" y="8" width="10" height="12" rx="5"/><path d="M9 8a3 3 0 0 1 6 0M12 12v8M3 14h4M17 14h4M4.5 8.5l3 1.5M19.5 8.5l-3 1.5M4.5 19.5l3-2.5M19.5 19.5l-3-2.5"/>'),
  I('laptop', 'Ноутбук', '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19.5h20"/>'),
  I('phone', 'Телефон', '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/>'),
  I('database', 'Данные', '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
  I('gear', 'Настройки', '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>'),
  I('tools', 'Ремонт', '<path d="M14.5 4a4.5 4.5 0 0 0-4.3 5.8L3.5 16.5v4h4l6.7-6.7A4.5 4.5 0 0 0 20 9.5l-3 1-2.5-2.5 1-3a4.5 4.5 0 0 0-1-1z"/>'),
  I('box', 'Поставка', '<path d="m3 7 9-4 9 4v10l-9 4-9-4z"/><path d="m3 7 9 4 9-4M12 11v10"/>'),
  I('cart', 'Покупки', '<path d="M3 4h2l2.5 11h11L21 8H6.2"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>'),
  I('wallet', 'Финансы', '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/>'),
  I('gift', 'Подарки', '<rect x="3" y="8" width="18" height="5" rx="1"/><path d="M5 13v8h14v-8M12 8v13"/><path d="M12 8C10 4 7 3.5 7 6s3 2 5 2c2 0 5 .5 5-2s-3-2-5 2z"/>'),
  I('scale', 'Право', '<path d="M12 3v18M7 21h10M4 7h16"/><path d="m6.5 7-3 6a3 3 0 0 0 6 0zM17.5 7l-3 6a3 3 0 0 0 6 0z"/>'),
  I('shield', 'Риски', '<path d="M12 3 20 6v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>'),
  I('lock', 'Безопасность', '<rect x="4.5" y="11" width="15" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>'),
  I('mail', 'Почта', '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
  I('chat', 'Общение', '<path d="M4 5h16v11H9.5L5 20v-4H4z"/>'),
  I('globe', 'Мир', '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>'),
  I('pin', 'Место', '<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>'),
  I('palette', 'Дизайн', '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4A4.6 4.6 0 0 0 21 9.8C21 6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>'),
  I('camera', 'Фото', '<path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="4"/>'),
  I('music', 'Музыка', '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>'),
  I('coffee', 'Отдых', '<path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 2.5v3M12 2.5v3"/>'),
  I('leaf', 'Сад', '<path d="M5 19C5 10 10 5 20 4c-1 10-6 15-15 15z"/><path d="m5 19 8-8"/>'),
  I('sun', 'Лето', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  I('moon', 'Вечер', '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  I('hash', 'Тема', '<path d="M5 9h15M4 15h15M10 3 8 21M16 3l-2 18"/>'),
];

export const iconById = (id) => PROJECT_ICONS.find((x) => x.id === id) || null;
export const iconSvg = (id, size = 16) => {
  const ic = iconById(id);
  return ic ? `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ic.body}</svg>` : '';
};
