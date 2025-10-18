/*Performing plugin operations on markdown file contents*/

import { Note, InlineNote, RegexNote, CLOZE_ERROR, NOTE_TYPE_ERROR, TAG_SEP, ID_REGEXP_STR, TAG_REGEXP_STR } from './note'
// ... 其他 import 保持不变

import { FROZEN_FIELDS_DICT } from './interfaces/field-interface'
import { AnkiConnectNote, AnkiConnectNoteAndID } from './interfaces/note-interface'
import { FileData } from './interfaces/settings-interface'
import { Note, InlineNote, RegexNote, CLOZE_ERROR, NOTE_TYPE_ERROR, TAG_SEP, ID_REGEXP_STR, TAG_REGEXP_STR } from './note'
import { Md5 } from 'ts-md5/dist/md5';
import * as AnkiConnect from './anki'
import * as c from './constants'
import { FormatConverter } from './format'
import { CachedMetadata, HeadingCache } from 'obsidian'

const double_regexp: RegExp = /(?:\r\n|\r|\n)((?:\r\n|\r|\n)(?:<!--)?ID: \d+)/g

function id_to_str(identifier:number, inline:boolean = false, comment:boolean = false): string {
    let result = "ID: " + identifier.toString()
    if (comment) {
        result = "<!--" + result + "-->"
    }
    if (inline) {
        result += " "
    } else {
        result += "\n"
    }
    return result
}

function string_insert(text: string, position_inserts: Array<[number, string]>): string {
	/*Insert strings in position_inserts into text, at indices.

    position_inserts will look like:
    [(0, "hi"), (3, "hello"), (5, "beep")]*/
	let offset = 0
	let sorted_inserts: Array<[number, string]> = position_inserts.sort((a, b):number => a[0] - b[0])
	for (let insertion of sorted_inserts) {
		let position = insertion[0]
		let insert_str = insertion[1]
		text = text.slice(0, position + offset) + insert_str + text.slice(position + offset)
		offset += insert_str.length
	}
	return text
}

function spans(pattern: RegExp, text: string): Array<[number, number]> {
	/*Return a list of span-tuples for matches of pattern in text.*/
	let output: Array<[number, number]> = []
	let matches = text.matchAll(pattern)
	for (let match of matches) {
		output.push(
			[match.index, match.index + match[0].length]
		)
	}
	return output
}

function contained_in(span: [number, number], spans: Array<[number, number]>): boolean {
	/*Return whether span is contained in spans (+- 1 leeway)*/
	return spans.some(
		(element) => span[0] >= element[0] - 1 && span[1] <= element[1] + 1
	)
}

function* findignore(pattern: RegExp, text: string, ignore_spans: Array<[number, number]>): IterableIterator<RegExpMatchArray> {
	let matches = text.matchAll(pattern)
	for (let match of matches) {
		if (!(contained_in([match.index, match.index + match[0].length], ignore_spans))) {
			yield match
		}
	}
}

abstract class AbstractFile {
    file: string
    path: string
    url: string
    original_file: string
    data: FileData
    file_cache: CachedMetadata

    frozen_fields_dict: FROZEN_FIELDS_DICT
    target_deck: string
    global_tags: string

    notes_to_add: AnkiConnectNote[]
    id_indexes: number[]
    notes_to_edit: AnkiConnectNoteAndID[]
    notes_to_delete: number[]
    all_notes_to_add: AnkiConnectNote[]

    note_ids: Array<number | null>
    card_ids: number[]
    tags: string[]

    formatter: FormatConverter

    constructor(file_contents: string, path:string, url: string, data: FileData, file_cache: CachedMetadata) {
        this.data = data
        this.file = file_contents
        this.path = path
        this.url = url
        this.original_file = this.file
        this.file_cache = file_cache
        this.formatter = new FormatConverter(file_cache, this.data.vault_name)
    }

    setup_frozen_fields_dict() {
        let frozen_fields_dict: FROZEN_FIELDS_DICT = {}
        for (let note_type in this.data.fields_dict) {
            let fields: string[] = this.data.fields_dict[note_type]
            let temp_dict: Record<string, string> = {}
            for (let field of fields) {
                temp_dict[field] = ""
            }
            frozen_fields_dict[note_type] = temp_dict
        }
        for (let match of this.file.matchAll(this.data.FROZEN_REGEXP)) {
            const [note_type, fields]: [string, string] = [match[1], match[2]]
            const virtual_note = note_type + "\n" + fields
            const parsed_fields: Record<string, string> = new Note(
                virtual_note,
                this.data.fields_dict,
                this.data.curly_cloze,
                this.data.highlights_to_cloze,
                this.formatter
            ).getFields()
            frozen_fields_dict[note_type] = parsed_fields
        }
        this.frozen_fields_dict = frozen_fields_dict
    }

    setup_target_deck() {
        const result = this.file.match(this.data.DECK_REGEXP)
        this.target_deck = result ? result[1] : this.data.template["deckName"]
    }

    setup_global_tags() {
        const result = this.file.match(this.data.TAG_REGEXP)
        this.global_tags = result ? result[1] : ""
    }

    getHash(): string {
        return Md5.hashStr(this.file) as string
    }

    abstract scanFile(): void

    scanDeletions() {
        for (let match of this.file.matchAll(this.data.EMPTY_REGEXP)) {
            this.notes_to_delete.push(parseInt(match[1]))
        }
    }

    getContextAtIndex(position: number): string {
        let result: string = this.path
        let currentContext: HeadingCache[] = []
        if (!(this.file_cache.hasOwnProperty('headings'))) {
            return result
        }
        for (let currentHeading of this.file_cache.headings) {
            if (position < currentHeading.position.start.offset) {
                //We've gone past position now with headings, so let's return!
                break
            }
            let insert_index: number = 0
            for (let contextHeading of currentContext) {
                if (currentHeading.level > contextHeading.level) {
                    insert_index += 1
                    continue
                }
                break
            }
            currentContext = currentContext.slice(0, insert_index)
            currentContext.push(currentHeading)
        }
        let heading_strs: string[] = []
        for (let contextHeading of currentContext) {
            heading_strs.push(contextHeading.heading)
        }
        let result_arr: string[] = [result]
        result_arr.push(...heading_strs)
        return result_arr.join(" > ")
    }

    abstract writeIDs(): void

    removeEmpties() {
        this.file = this.file.replace(this.data.EMPTY_REGEXP, "")
    }

    getCreateDecks(): AnkiConnect.AnkiConnectRequest {        
        let actions: AnkiConnect.AnkiConnectRequest[] = []
        for (let note of this.all_notes_to_add) {
            actions.push(AnkiConnect.createDeck(note.deckName))
        }
        return AnkiConnect.multi(actions)
    }

    getAddNotes(): AnkiConnect.AnkiConnectRequest {
        let actions: AnkiConnect.AnkiConnectRequest[] = []
        for (let note of this.all_notes_to_add) {
            actions.push(AnkiConnect.addNote(note))
        }
        return AnkiConnect.multi(actions)
    }

    getDeleteNotes(): AnkiConnect.AnkiConnectRequest {
        return AnkiConnect.deleteNotes(this.notes_to_delete)
    }

    getUpdateFields(): AnkiConnect.AnkiConnectRequest {
        let actions: AnkiConnect.AnkiConnectRequest[] = []
        for (let parsed of this.notes_to_edit) {
            actions.push(
                AnkiConnect.updateNoteFields(
                    parsed.identifier, parsed.note.fields
                )
            )
        }
        return AnkiConnect.multi(actions)
    }

    getNoteInfo(): AnkiConnect.AnkiConnectRequest {
        let IDs: number[] = []
        for (let parsed of this.notes_to_edit) {
            IDs.push(parsed.identifier)
        }
        return AnkiConnect.notesInfo(IDs)
    }

    getChangeDecks(): AnkiConnect.AnkiConnectRequest {
        return AnkiConnect.changeDeck(this.card_ids, this.target_deck)
    }

    getClearTags(): AnkiConnect.AnkiConnectRequest {
        let IDs: number[] = []
        for (let parsed of this.notes_to_edit) {
            IDs.push(parsed.identifier)
        }
        return AnkiConnect.removeTags(IDs, this.tags.join(" "))
    }

    getAddTags(): AnkiConnect.AnkiConnectRequest {
        let actions: AnkiConnect.AnkiConnectRequest[] = []
        for (let parsed of this.notes_to_edit) {
            actions.push(
                AnkiConnect.addTags([parsed.identifier], parsed.note.tags.join(" ") + " " + this.global_tags)
            )
        }
        return AnkiConnect.multi(actions)
    }

}

export class AllFile extends AbstractFile {
    ignore_spans: [number, number][]
    custom_regexps: Record<string, string>
    inline_notes_to_add: AnkiConnectNote[]
    inline_id_indexes: number[]
    regex_notes_to_add: AnkiConnectNote[]
    regex_id_indexes: number[]

    constructor(file_contents: string, path:string, url: string, data: FileData, file_cache: CachedMetadata) {
        super(file_contents, path, url, data, file_cache)
        this.custom_regexps = data.custom_regexps
    }

    add_spans_to_ignore() {
        this.ignore_spans = []
        this.ignore_spans.push(...spans(this.data.FROZEN_REGEXP, this.file))
        const deck_result = this.file.match(this.data.DECK_REGEXP)
        if (deck_result) {
            this.ignore_spans.push([deck_result.index, deck_result.index + deck_result[0].length])
        }
        const tag_result = this.file.match(this.data.TAG_REGEXP)
        if (tag_result) {
            this.ignore_spans.push([tag_result.index, tag_result.index + tag_result[0].length])
        }
        this.ignore_spans.push(...spans(this.data.NOTE_REGEXP, this.file))
        this.ignore_spans.push(...spans(this.data.INLINE_REGEXP, this.file))
        this.ignore_spans.push(...spans(c.OBS_INLINE_MATH_REGEXP, this.file))
        this.ignore_spans.push(...spans(c.OBS_DISPLAY_MATH_REGEXP, this.file))
        this.ignore_spans.push(...spans(c.OBS_CODE_REGEXP, this.file))
        this.ignore_spans.push(...spans(c.OBS_DISPLAY_CODE_REGEXP, this.file))
    }

    setupScan() {
        this.setup_frozen_fields_dict()
        this.setup_target_deck()
        this.setup_global_tags()
        this.add_spans_to_ignore()
        this.notes_to_add = []
        this.inline_notes_to_add = []
        this.regex_notes_to_add = []
        this.id_indexes = []
        this.inline_id_indexes = []
        this.regex_id_indexes = []
        this.notes_to_edit = []
        this.notes_to_delete = []
    }

    scanNotes() {
        for (let note_match of this.file.matchAll(this.data.NOTE_REGEXP)) {
            let [note, position]: [string, number] = [note_match[1], note_match.index + note_match[0].indexOf(note_match[1]) + note_match[1].length]
            // That second thing essentially gets the index of the end of the first capture group.
            let parsed = new Note(
                note,
                this.data.fields_dict,
                this.data.curly_cloze,
                this.data.highlights_to_cloze,
                this.formatter
            ).parse(
                this.target_deck,
                this.url,
                this.frozen_fields_dict,
                this.data,
                this.data.add_context ? this.getContextAtIndex(note_match.index) : ""
            )
            if (parsed.identifier == null) {
                // Need to make sure global_tags get added
                parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
                this.notes_to_add.push(parsed.note)
                this.id_indexes.push(position)
            } else if (!this.data.EXISTING_IDS.includes(parsed.identifier)) {
                if (parsed.identifier == CLOZE_ERROR) {
                    continue
                }
                // Need to show an error otherwise
                else if (parsed.identifier == NOTE_TYPE_ERROR) {
                    console.warn("Did not recognise note type ", parsed.note.modelName, " in file ", this.path)
                } else {
                    console.warn("Note with id", parsed.identifier, " in file ", this.path, " does not exist in Anki!")
                }
            } else {
                this.notes_to_edit.push(parsed)
            }
        }
    }

    scanInlineNotes() {
        for (let note_match of this.file.matchAll(this.data.INLINE_REGEXP)) {
            let [note, position]: [string, number] = [note_match[1], note_match.index + note_match[0].indexOf(note_match[1]) + note_match[1].length]
            // That second thing essentially gets the index of the end of the first capture group.
            let parsed = new InlineNote(
                note,
                this.data.fields_dict,
                this.data.curly_cloze,
                this.data.highlights_to_cloze,
                this.formatter
            ).parse(
                this.target_deck,
                this.url,
                this.frozen_fields_dict,
                this.data,
                this.data.add_context ? this.getContextAtIndex(note_match.index) : ""
            )
            if (parsed.identifier == null) {
                // Need to make sure global_tags get added
                parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
                this.inline_notes_to_add.push(parsed.note)
                this.inline_id_indexes.push(position)
            } else if (!this.data.EXISTING_IDS.includes(parsed.identifier)) {
                // Need to show an error
                if (parsed.identifier == CLOZE_ERROR) {
                    continue
                }
                console.warn("Note with id", parsed.identifier, " in file ", this.path, " does not exist in Anki!")
            } else {
                this.notes_to_edit.push(parsed)
            }
        }
    }

    search(note_type: string, regexp_str: string) {
        //Search the file for regex matches
        //ignoring matches inside ignore_spans,
        //and adding any matches to ignore_spans.
        for (let search_id of [true, false]) {
            for (let search_tags of [true, false]) {
                let id_str = search_id ? ID_REGEXP_STR : ""
                let tag_str = search_tags ? TAG_REGEXP_STR : ""
                let regexp: RegExp = new RegExp(regexp_str + tag_str + id_str, 'gm')
                for (let match of findignore(regexp, this.file, this.ignore_spans)) {
                    this.ignore_spans.push([match.index, match.index + match[0].length])
                    const parsed: AnkiConnectNoteAndID = new RegexNote(
                        match, note_type, this.data.fields_dict,
                        search_tags, search_id, this.data.curly_cloze, this.data.highlights_to_cloze, this.formatter
                    ).parse(
                        this.target_deck,
                        this.url,
                        this.frozen_fields_dict,
                        this.data,
                        this.data.add_context ? this.getContextAtIndex(match.index) : ""
                    )
                    if (search_id) {
                        if (!(this.data.EXISTING_IDS.includes(parsed.identifier))) {
                            if (parsed.identifier == CLOZE_ERROR) {
                                // This means it wasn't actually a note! So we should remove it from ignore_spans
                                this.ignore_spans.pop()
                                continue
                            }
                            console.warn("Note with id", parsed.identifier, " in file ", this.path, " does not exist in Anki!")
                        } else {
                            this.notes_to_edit.push(parsed)
                        }
                    } else {
                        if (parsed.identifier == CLOZE_ERROR) {
                            // This means it wasn't actually a note! So we should remove it from ignore_spans
                            this.ignore_spans.pop()
                            continue
                        }
                        parsed.note.tags.push(...this.global_tags.split(TAG_SEP))
                        this.regex_notes_to_add.push(parsed.note)
                        this.regex_id_indexes.push(match.index + match[0].length)
                    }
                }
            }
        }
    }

    // 文件: src/file.ts, 在 AllFile 类的 scanFile() 方法中
    scanFile() {
        this.setupScan()
        this.scanNotes()
        this.scanInlineNotes()
        
        // =================================================================
        // START: 【定制H2自动解析逻辑】
        // =================================================================

        // 目标 Note Type 必须是 Anki 中已有的卡片模板名称，例如 '问答题' 或 'Basic'
        const TARGET_NOTE_TYPE: string = "问答题"; 
        
        // 我们之前验证过的 H2 正则表达式 (非贪婪匹配 H2 及其下的内容直到下一个 H2)
        // match[1] = H2 标题 (正面), match[2] = H2 下的内容 (背面)
        const H2_AUTO_REGEX = /(?s)^#{2} (.+)\n(.*?)(?=\n^## |\Z)/g;

        // 确保该 Note Type 存在于 fields_dict 中，否则插件会报错
        if (this.data.fields_dict.hasOwnProperty(TARGET_NOTE_TYPE)) {
            
            // 扫描文件并查找 H2 匹配项，忽略已经在 ignore_spans 中的内容
            for (let match of findignore(H2_AUTO_REGEX, this.file, this.ignore_spans)) {
                
                // 1. 立即将匹配到的块添加到 ignore_spans 中，防止被后续的正则重复解析
                this.ignore_spans.push([match.index, match.index + match[0].length]);
                
                // 2. 构建 RegexNote 所需的 'match' 数组
                // 注意：match 数组的索引和长度必须与 RegexNote constructor 中对 tags/id 的处理逻辑对应
                // 这里我们假设 tags 和 id 都是 false，所以只保留 match[0], match[1], match[2]
                // 由于 RegexNote 构造函数会 pop 两次，我们必须传入包含 [full match, front, back, tag, id] 的数组
                // 因为我们不从正则获取 tag/id，所以我们将它们设为空
                const regexMatchArray: RegExpMatchArray = [
                    match[0],    
                    match[1],    
                    match[2], 
                    "", // 占位符: Tags 
                    "", // 占位符: ID
                ] as RegExpMatchArray;

                // 3. 使用 RegexNote 类来格式化卡片
                const parsed = new RegexNote(
                    regexMatchArray, 
                    TARGET_NOTE_TYPE, 
                    this.data.fields_dict, 
                    false, // search_tags: false 
                    false, // search_id: false
                    this.data.curly_cloze, 
                    this.data.highlights_to_cloze, 
                    this.formatter
                ).parse(
                    this.target_deck,
                    this.url,
                    this.frozen_fields_dict,
                    this.data,
                    this.data.add_context ? this.getContextAtIndex(match.index) : ""
                );

                // 4. 添加到新增卡片列表
                parsed.note.tags.push(...this.global_tags.split(TAG_SEP));
                this.regex_notes_to_add.push(parsed.note);
                // 记录索引，用于后续写入 ID
                this.regex_id_indexes.push(match.index + match[0].length);
            }
        } else {
            // 可选：添加一个控制台警告，提示用户在 Anki 中创建该 Note Type
            console.warn(`Anki Note Type "${TARGET_NOTE_TYPE}" not found. Please create it in Anki.`);
        }
        
        // =================================================================
        // END: 【定制H2自动解析逻辑】
        // =================================================================
        
        for (let note_type in this.custom_regexps) { // 原本的自定义正则扫描
            const regexp_str: string = this.custom_regexps[note_type]
            if (regexp_str) {
                this.search(note_type, regexp_str)
            }
        }
        this.all_notes_to_add = this.notes_to_add.concat(this.inline_notes_to_add).concat(this.regex_notes_to_add)
        this.scanDeletions()
    }
