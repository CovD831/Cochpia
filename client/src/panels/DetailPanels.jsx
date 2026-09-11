// Overlay detail panels, split out of App() (R-020 stage 4).
//
// Only the profile panel was moved. It is the one panel an end-to-end check
// actually opens (e2e S9), which matters because a missing prop here does not
// fail the build -- it throws at render time inside the panel.
//
// The growth / history / settings / task / event panels deliberately stay in
// main.jsx: they live behind the inspector floating window, no end-to-end check
// reaches them yet, and extracting a panel I cannot render is how a refactor
// becomes a silent break waiting for a user to click. Cover them first.

import React from 'react';
import FeatherIcon from '../icons/FeatherIcon';
import CharacterProfile from '../profile/CharacterProfile';
import AvatarPicker from '../profile/AvatarPicker';

// Extracted verbatim; the only edit is setProfileOpen(false) -> onClose().
export function ProfilePanel({ pendingApproval, respondApproval, onClose }) {
  return <div className="settings-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-panel detail-panel" role="dialog" aria-modal="true" aria-labelledby="profile-title"><CharacterProfile onClose={() => onClose()} /></section></div>;
}
