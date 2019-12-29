import { practiceWithContextFactory } from '../../test/factories/PracticeWithContextFactory';
import { PracticeEvaluationResult, PracticeImpact } from '../../model';
import { CIReportBuilder } from './CIReportBuilder';

describe('CIReportBuilder', () => {
  const practicingHighImpactPracticeWithCtx = practiceWithContextFactory();
  const notPracticingHighImpactPracticeWithCtx = practiceWithContextFactory({ evaluation: PracticeEvaluationResult.notPracticing });

  describe('#build', () => {
    it('one practicing practice contains all necessary data', () => {
      const result = new CIReportBuilder([practicingHighImpactPracticeWithCtx]).build();

      const mustContainElements = [CIReportBuilder.ciReportIndicator];

      mustContainElements.forEach((e) => {
        expect(result).toContain(e);
      });
    });

    it('one practicing practice and one not practicing', () => {
      const result = new CIReportBuilder([practicingHighImpactPracticeWithCtx, notPracticingHighImpactPracticeWithCtx]).build();

      const mustContainElements = [
        CIReportBuilder.ciReportIndicator,
        notPracticingHighImpactPracticeWithCtx.practice.name,
        notPracticingHighImpactPracticeWithCtx.practice.url,
      ];

      mustContainElements.forEach((e) => {
        expect(result).toContain(e);
      });
    });

    it('all impacted practices', () => {
      const result = new CIReportBuilder([
        practicingHighImpactPracticeWithCtx,
        notPracticingHighImpactPracticeWithCtx,
        practiceWithContextFactory({
          overridenImpact: PracticeImpact.medium,
          evaluation: PracticeEvaluationResult.notPracticing,
        }),
        practiceWithContextFactory({
          overridenImpact: PracticeImpact.small,
          evaluation: PracticeEvaluationResult.notPracticing,
        }),
        practiceWithContextFactory({
          overridenImpact: PracticeImpact.hint,
          evaluation: PracticeEvaluationResult.notPracticing,
        }),
        practiceWithContextFactory({
          overridenImpact: PracticeImpact.off,
          evaluation: PracticeEvaluationResult.notPracticing,
          isOn: false,
        }),
        practiceWithContextFactory({ overridenImpact: PracticeImpact.high, evaluation: PracticeEvaluationResult.unknown }),
      ]).build();

      expect(result).toContain('Improvements with highest impact');
      expect(result).toContain('Improvements with medium impact');
      expect(result).toContain('Improvements with minor impact');
      expect(result).toContain('Also consider');
      expect(result).toContain('Evaluation of these practices failed');
      expect(result).toContain('You have turned off these practices');
    });
  });
});
