import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, of, combineLatest } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { CONFIG } from '../../environments/environment';
import {
  Question, QuestionStatus, SearchResults, SearchCriteria,
  BulkUploadFileInfo, BulkUpload, QueryParams, QueryParam
} from '../../shared/model';
import { Store } from '@ngrx/store';
import { CoreState } from '../store';
import { QuestionActions } from '../store/actions';
import { DbService } from './../db-service';

@Injectable()
export class QuestionService {

  constructor(
    private store: Store<CoreState>,
    private questionActions: QuestionActions,
    private http: HttpClient,
    private dbService: DbService) {
  }

  // Elasticsearch
  getQuestionOfTheDay(isNextQuestion: boolean): Observable<Question> {
    let url: string = CONFIG.functionsUrl + '/app/question/day';
    url = (isNextQuestion) ? `${url}/next` : `${url}/current`
    return this.http.get<Question>(url);
  }

  getQuestions(startRow: number, pageSize: number, criteria: SearchCriteria): Observable<SearchResults> {
    const url: string = CONFIG.functionsUrl + '/app/question/';

    return this.http.post<SearchResults>(url + startRow + '/' + pageSize, criteria);
  }

  // Firestore
  getUserQuestions(userId: string, published: boolean): Observable<Question[]> {
    const collection = (published) ? 'questions' : 'unpublished_questions';
    const queryParams = { condition: [{ name: 'created_uid', comparator: '==', value: userId }] };
    return this.dbService.valueChanges(collection, '', queryParams)
      .pipe(
        map(qs => qs.map(q => Question.getViewModelFromDb(q))),
        catchError(error => {
          console.log(error);
          return of(null);
        }));
  }

  // get Questions by bulk upload id
  getQuestionsForBulkUpload(bulkUploadFileInfo: BulkUploadFileInfo, published: boolean): Observable<Question[]> {
    const collection = (published) ? 'questions' : 'unpublished_questions';
    const queryParams = {
      condition: [{ name: 'created_uid', comparator: '==', value: bulkUploadFileInfo.created_uid },
      { name: 'bulkUploadId', comparator: '==', value: bulkUploadFileInfo.id }]
    };

    return this.dbService.valueChanges(collection, '', queryParams)
      .pipe(
        map(qs => qs.map(q => Question.getViewModelFromDb(q))),
        catchError(error => {
          console.log(error);
          return of(null);
        }));
  }

  getUnpublishedQuestions(flag: boolean, filterStatus?: Array<number>): Observable<Question[]> {
    const question_source = (!flag) ? 'question' : 'bulk-question';
    const queryParams = new QueryParams();

    const queryObservables = [];

    if (filterStatus && filterStatus.length > 0) {
      filterStatus.map((status) => {
        queryParams.condition = [];
        let queryParam = new QueryParam('source', '==', question_source);
        queryParams.condition.push(queryParam);
        queryParam = new QueryParam('status', '==', status);
        queryParams.condition.push(queryParam);

        queryObservables.push(this.dbService.valueChanges('unpublished_questions', '', { ...queryParams }));
      });
    } else {
      queryParams.condition = [];
      queryObservables.push(this.dbService.valueChanges('unpublished_questions', '', queryParams));
    }


    return combineLatest(queryObservables)
      .pipe(
        map(questions => {
          return [].concat.apply([], questions);
        })
      )
      .pipe(catchError(error => {
        console.log(error);
        return of(null);
      }));
  }


  saveQuestion(question: Question) {
    const dbQuestion = Object.assign({}, question); // object to be saved

    if (!question.id || question.id === '') {
      dbQuestion['source'] = 'question';
      this.dbService.createDoc('unpublished_questions', dbQuestion).then(ref => {
        this.store.dispatch(this.questionActions.addQuestionSuccess());
      });
    } else {
      this.dbService.setDoc('unpublished_questions', dbQuestion.id, dbQuestion).then(ref => {
        this.store.dispatch(this.questionActions.addQuestionSuccess());
      });
    }

  }

  saveBulkQuestions(bulkUpload: BulkUpload) {
    const dbQuestions: Array<any> = [];
    const bulkUploadFileInfo = bulkUpload.bulkUploadFileInfo;
    const questions = bulkUpload.questions;
    const bulkUploadId = this.dbService.createId(); //this.db.createId();
    // store file in file storage
    // Not written any code monitor progress or error
    this.dbService.upload(`bulk_upload/${bulkUploadFileInfo.created_uid}/${bulkUploadId}-${bulkUpload.file.name}`, bulkUpload.file)
      .then(ref => {
        for (const question of questions) {
          if (question !== null) {
            question.bulkUploadId = bulkUploadId;
            const dbQuestion = Object.assign({}, question); // object to be saved
            dbQuestion.id = this.dbService.createId();
            // Do we really need to copy answer object as well?
            dbQuestion.answers = dbQuestion.answers.map((obj) => { return Object.assign({}, obj) });
            dbQuestions.push(dbQuestion);
          }
        }
        this.addBulkUpload(bulkUploadFileInfo, dbQuestions, bulkUploadId);
      });

  }
  addBulkUpload(bulkUploadFileInfo: BulkUploadFileInfo, questions: Array<Question>, id: string) {
    // save question
    const dbFile = Object.assign({}, bulkUploadFileInfo);
    dbFile.id = id;
    dbFile.rejected = 0;
    dbFile.approved = 0;
    dbFile.status = 'Under Review';
    this.dbService.setDoc('bulk_uploads', dbFile['id'], dbFile).then(ref => {
      this.storeQuestion(0, questions);
    });
  }

  storeQuestion(index: number, questions: Array<Question>): void {
    const question = questions[index];
    question['source'] = 'bulk-question';
    this.dbService.setDoc('unpublished_questions', question.id, question)
      .then(ref => {
        if (index === questions.length - 1) {
          this.store.dispatch(this.questionActions.addQuestionSuccess());
        } else {
          index++;
          this.storeQuestion(index, questions);
        }
      });
  }

  approveQuestion(question: Question) {
    const dbQuestion = Object.assign({}, question); // object to be saved
    const questionId = dbQuestion.id;
    dbQuestion.status = QuestionStatus.APPROVED;
    // Transaction to remove from unpublished and add to published questions collection
    const firestoreInstance = this.dbService.getFireStore();
    firestoreInstance.firestore.runTransaction(transaction => {
      return transaction.get(firestoreInstance.doc('/unpublished_questions/' + questionId).ref).then(doc =>
        transaction.set(firestoreInstance.doc('/questions/' + questionId).ref, dbQuestion).delete(doc.ref)
      );
    });
  }
}
