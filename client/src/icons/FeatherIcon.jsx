import React from 'react';
import home from './feather/home.svg?raw';
import edit3 from './feather/edit-3.svg?raw';
import hash from './feather/hash.svg?raw';
import layers from './feather/layers.svg?raw';
import music from './feather/music.svg?raw';
import settings from './feather/settings.svg?raw';
import moreHorizontal from './feather/more-horizontal.svg?raw';
import paperclip from './feather/paperclip.svg?raw';
import mic from './feather/mic.svg?raw';
import volume2 from './feather/volume-2.svg?raw';
import arrowUp from './feather/arrow-up.svg?raw';
import x from './feather/x.svg?raw';
import plus from './feather/plus.svg?raw';
import users from './feather/users.svg?raw';
import calendar from './feather/calendar.svg?raw';
import check from './feather/check.svg?raw';
import minus from './feather/minus.svg?raw';
import maximize2 from './feather/maximize-2.svg?raw';
import minimize2 from './feather/minimize-2.svg?raw';
import grid from './feather/grid.svg?raw';
import play from './feather/play.svg?raw';
import pause from './feather/pause.svg?raw';
import skipForward from './feather/skip-forward.svg?raw';
import stopCircle from './feather/stop-circle.svg?raw';
import upload from './feather/upload.svg?raw';
import download from './feather/download.svg?raw';
import eye from './feather/eye.svg?raw';
import messageCircle from './feather/message-circle.svg?raw';
import userPlus from './feather/user-plus.svg?raw';
import trash2 from './feather/trash-2.svg?raw';
import chevronDown from './feather/chevron-down.svg?raw';
import chevronUp from './feather/chevron-up.svg?raw';
import sliders from './feather/sliders.svg?raw';
import sun from './feather/sun.svg?raw';
import moon from './feather/moon.svg?raw';
import fileText from './feather/file-text.svg?raw';

const icons = {
  home, edit3, hash, layers, music, settings, moreHorizontal,
  paperclip, mic, volume2, arrowUp, x, plus, users, calendar, check, minus,
  maximize2, minimize2, grid, play, pause, skipForward, stopCircle, upload,
  download, eye, messageCircle, userPlus, trash2, chevronDown, chevronUp,
  sliders, sun, moon, fileText
};

export function FeatherIcon({ name, size = 16, strokeWidth = 2, title, className = '' }) {
  const source = icons[name];
  if (!source) return null;
  const svg = source
    .replace(/width="[^"]*"/, `width="${size}"`)
    .replace(/height="[^"]*"/, `height="${size}"`)
    .replace(/stroke-width="[^"]*"/, `stroke-width="${strokeWidth}"`)
    .replace('<svg', '<svg aria-hidden="true" focusable="false"');
  return <span className={`feather-icon ${className}`} aria-label={title} title={title} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export default FeatherIcon;
