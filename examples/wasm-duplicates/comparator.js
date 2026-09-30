function compareAnalyses(oldAnalysis, newAnalysis) {
  const comparison = {
    newDuplicates: [],
    resolvedDuplicates: [],
    changedGroups: [],
    newNearDuplicates: [],
    metrics: {
      oldTotalFunctions: oldAnalysis.totalFunctions,
      newTotalFunctions: newAnalysis.totalFunctions,
      oldUniqueFunctions: oldAnalysis.uniqueFunctions,
      newUniqueFunctions: newAnalysis.uniqueFunctions,
      oldDuplicateGroups: oldAnalysis.duplicateGroups,
      newDuplicateGroups: newAnalysis.duplicateGroups
    }
  };

  const oldGroups = new Map(oldAnalysis.groups.map(g => [g.fingerprint, g]));
  const newGroups = new Map(newAnalysis.groups.map(g => [g.fingerprint, g]));

  // Check for new duplicates
  for (const [fingerprint, newGroup] of newGroups) {
    if (!oldGroups.has(fingerprint)) {
      comparison.newDuplicates.push(newGroup);
    }
  }

  // Check for resolved duplicates
  for (const [fingerprint, oldGroup] of oldGroups) {
    if (!newGroups.has(fingerprint)) {
      comparison.resolvedDuplicates.push(oldGroup);
    }
  }

  // Check for changed groups
  for (const [fingerprint, oldGroup] of oldGroups) {
    if (newGroups.has(fingerprint)) {
      const newGroup = newGroups.get(fingerprint);
      if (oldGroup.functions.length !== newGroup.functions.length) {
        comparison.changedGroups.push({
          fingerprint,
          oldFunctions: oldGroup.functions,
          newFunctions: newGroup.functions,
          oldSize: oldGroup.bodySize,
          newSize: newGroup.bodySize
        });
      }
    }
  }

  // Check for new near-duplicates (similarity threshold changes)
  for (const newGroup of newAnalysis.groups) {
    if (newGroup.similarity !== 'exact' && newGroup.similarity !== 'normalized') {
      comparison.newNearDuplicates.push(newGroup);
    }
  }

  return comparison;
}

module.exports = { compareAnalyses };
