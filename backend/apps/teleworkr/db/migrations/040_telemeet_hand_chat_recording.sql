-- 040_telemeet_hand_chat_recording.sql — raise hand, in-call chat, and the "someone is recording" flag.
--
-- Recording happens in the recorder's own browser and the file goes to their own disk: the server still
-- never receives media. What it holds is only the flag (recording_since), so everyone else in the call
-- can be told, in the roster and in a banner, that a copy is being made.
--
-- room_chat_message is the call's side conversation. It is for the people in the call and is deleted
-- when the room ends — only the shared notes, which people deliberately write, outlive the call.

ALTER TABLE room_participant ADD COLUMN hand_raised_at integer;
ALTER TABLE room_participant ADD COLUMN recording_since integer;

CREATE TABLE room_chat_message (
    message_id integer primary key autoincrement,
    room_id varchar not null,
    org_id varchar not null,
    person_id varchar not null,
    text varchar not null,
    created_at integer not null,
    FOREIGN KEY (room_id) REFERENCES meeting_room(room_id)
);
CREATE INDEX idx_room_chat_room ON room_chat_message(room_id, message_id);
