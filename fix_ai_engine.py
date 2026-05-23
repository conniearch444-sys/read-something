import re

with open('utils/readerAiEngine.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update import
content = content.replace(
    '    readConversationBucket,\n    saveCrossBookMemory,\n} from \'./readerChatRuntime\';',
    '    readConversationBucket,\n    autoUpdateBookProfileFromCards,\n} from \'./readerChatRuntime\';'
)

# 2. Add shelfBookTitles to RunConversationGenerationParams
content = content.replace(
    '  ragContext?: string;\n}\n\ntype RunGenerationSkipReason',
    '  ragContext?: string;\n  shelfBookTitles?: string[];\n}\n\ntype RunGenerationSkipReason'
)

# 3. Add shelf books to prompt
old_shelf = '  pushPromptLine(lines, \'otherInstructions\', buildCrossBookMemoryText(characterRealName));\n  pushPromptLine(lines, \'otherInstructions\', \'<char_profile>\');'
new_shelf = '''  pushPromptLine(lines, 'otherInstructions', buildCrossBookMemoryText(characterRealName));
  if (params.shelfBookTitles && params.shelfBookTitles.length > 0) {
    const currentBook = params.activeBookTitle || '';
    const otherBooks = params.shelfBookTitles.filter(t => t !== currentBook);
    if (otherBooks.length > 0) {
      pushPromptLine(lines, 'otherInstructions', '');
      pushPromptLine(lines, 'otherInstructions', '<bookshelf>');
      pushPromptLine(lines, 'otherInstructions', `【用户书架上的其他书（共${otherBooks.length}本）】`);
      otherBooks.forEach((title, i) => pushPromptLine(lines, 'otherInstructions', `${i + 1}. 《${title}》`));
      pushPromptLine(lines, 'otherInstructions', '你之前可能和用户一起读过这些书，可以自然地在聊天中提及。');
      pushPromptLine(lines, 'otherInstructions', '</bookshelf>');
    }
  }
  pushPromptLine(lines, 'otherInstructions', '<char_profile>');'''
content = content.replace(old_shelf, new_shelf)

# 4. Pass shelfBookTitles to buildAiPrompt
content = content.replace(
    '      ragContext,\n    });\n    console.groupCollapsed',
    '      ragContext,\n      shelfBookTitles: params.shelfBookTitles,\n    });\n    console.groupCollapsed'
)

# 5. Replace saveCrossBookMemory call
old_save = 'if (bucket && bucket.chatSummaryCards.length > 0) {\n  const latestCard = bucket.chatSummaryCards[bucket.chatSummaryCards.length - 1];\n  saveCrossBookMemory(\n    bucket.characterName || characterRealName,\n    latestCard.content,\n    activeBookId || undefined,\n    latestCard.id,\n  );\n}'
new_save = '''if (bucket && bucket.chatSummaryCards.length > 0) {
  autoUpdateBookProfileFromCards(
    activeBookId || '',
    activeBookTitle || '',
    bucket.characterName || characterRealName,
    bucket.chatSummaryCards,
  );
}'''
content = content.replace(old_save, new_save)

with open('utils/readerAiEngine.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("Done")
